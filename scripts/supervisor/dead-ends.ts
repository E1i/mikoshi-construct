import type { DatabaseSync } from 'node:sqlite'
import type { WaitLift, WaitLiftKind } from '../core/db.js'
import type { Shape } from './expected-time.js'
import { CLOSED_CARD, DEFERRED_CARD, DROPPED_CARD, MERGED_CARD, QUEUED_CARD, STOPPED_CARD } from '../core/card-automaton.js'
import { holderOf, holdLayersOf } from '../core/card-hold.js'
import { lastReducedOwnerWaits } from '../core/card-readings.js'
import { appendEvent, currentHeadOf, inTransaction, liftHeldAtOpen, openOwnerWait } from '../core/db.js'
import { events, ofCard } from '../core/events-query.js'
import { BOARD_ALARM, CARD_HELD, CARD_RELEASED, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, REJECTED, TASK_REQUEUED } from '../core/events.js'
import { expectedMinutes, RoundMeasures } from './expected-time.js'

export const DEAD_END = 'dead_end'
export const DEAD_END_ACTOR = 'worker:supervisor:dead-ends'
export const UNMEASURED_ROUND_MINUTES = 60
const MINUTE_MS = 60_000
const RAISED_TYPES = [BOARD_ALARM, OWNER_WAIT_OPENED] as const
export const DEAD_END_LIFTS: readonly WaitLiftKind[] = ['passed-on-head', 'new-head', 'amend', 'decision', 'pr-merged']
const WINDOW_ACTIONS: readonly string[] = [CARD_RELEASED, CARD_HELD, TASK_REQUEUED]

export const HELD_ELSEWHERE_STATES: readonly string[] = [MERGED_CARD, CLOSED_CARD, DROPPED_CARD, QUEUED_CARD, DEFERRED_CARD]

export type Selecting = (card: number, ts: string) => readonly string[]

export interface UnheldCard {
  card: number
  state: string
  pr: number | null
  lastEvent: LastEvent
}

export interface DeadEndEvents {
  lastStopReason: (card: number) => string | null
  cardsOfUnclosedOwnerWaits: () => readonly number[]
  cardsNobodyHolds: (heldElsewhere: readonly string[], ignoredActor: string) => readonly UnheldCard[]
  latestTaskKey: (card: number) => string | null
  routedByADecision: (card: number) => boolean
}

export interface DeadEndParts {
  selecting: Selecting
  events: DeadEndEvents
}

interface LastEvent {
  id: number
  type: string
  ts: string
}

export interface DeadEnd {
  card: number
  pr: number | null
  state: string
  condition: string | null
  lastEvent: LastEvent
  idleMinutes: number
  roundMinutes: number
  shape: Shape
  reason: string
}

export function stateNamed(end: Pick<DeadEnd, 'state' | 'condition'>): string {
  return end.condition === null ? end.state : `${end.state} (${end.condition})`
}

export function deadEndReason(end: Omit<DeadEnd, 'reason'>, movers: readonly string[]): string {
  const named = stateNamed(end)
  const why = movers.length === 0
    ? `no node's queue candidates select #${end.card} as a ${named} card`
    : `the candidates of ${movers.join(', ')} select #${end.card} as a ${named} card, and none of them holds a live or queued task for it, nor is an owner wait open on it`
  return `dead end: card #${end.card} is ${named}, last event ${end.lastEvent.type} #${end.lastEvent.id} ${end.idleMinutes} min ago, past its round time of ${end.roundMinutes} min for ${end.shape.size}/${end.shape.contour}; ${why}`
}

export function deadEndWaitText(end: DeadEnd): string {
  return `card #${end.card} is at a dead end in state ${stateNamed(end)}: ${end.reason}. Give it its route with an owner move, or decide which node moves a ${stateNamed(end)} card`
}

export class DeadEnds {
  private readonly measures: RoundMeasures

  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly parts: DeadEndParts) {
    this.measures = new RoundMeasures(db)
  }

  found(): DeadEnd[] {
    const at = this.clock()
    const now = at.getTime()
    const held = this.cardsUnderAnOpenOwnerWait()
    const unheld = this.parts.events.cardsNobodyHolds(HELD_ELSEWHERE_STATES, DEAD_END_ACTOR)
      .filter(card => !held.has(card.card) && !this.stoppedUnderAHold(card) && !this.lastMoveIsItsOwnRejectedRaise(card) && !this.windowCarriesAnOwnerAnswer(card))
    if (unheld.length === 0)
      return []
    const samples = this.measures.samples()
    return unheld.flatMap((card) => {
      const { lastEvent } = card
      const shape = this.measures.shapeOfCard(card.card)
      const measured = [expectedMinutes(samples, 'answer', shape), expectedMinutes(samples, 'review', shape)].filter(minutes => minutes !== null)
      const roundMinutes = measured.length === 0 ? UNMEASURED_ROUND_MINUTES : Math.max(...measured)
      const idleMinutes = Math.floor((now - Date.parse(lastEvent.ts)) / MINUTE_MS)
      if (idleMinutes <= roundMinutes)
        return []
      const condition = this.stopReasonOf(card)
      const end = { card: card.card, pr: card.pr, state: card.state, condition, lastEvent, idleMinutes, roundMinutes, shape }
      return [{ ...end, reason: deadEndReason(end, this.parts.selecting(card.card, at.toISOString())) }]
    })
  }

  step(): string[] {
    const ts = this.clock().toISOString()
    return this.found().flatMap(end => inTransaction(this.db, () => {
      const taskKey = this.parts.events.latestTaskKey(end.card)
      const payload = taskKey === null ? { reason: end.reason, detail: DEAD_END } : { reason: end.reason, detail: DEAD_END, task_key: taskKey }
      const raised = appendEvent(this.db, { ts, type: BOARD_ALARM, actor: DEAD_END_ACTOR, cardId: end.card, pr: end.pr, head: null, dedupeKey: `${BOARD_ALARM}:${DEAD_END}:${end.card}:${end.lastEvent.id}`, payload, legacy: false })
      if (!raised)
        return []
      const wait = this.ownerWaitOf(end, ts)
      return [`${BOARD_ALARM} #${end.card} ${end.reason}${wait === null ? '' : `; owner wait ${wait}`}`]
    }))
  }

  private ownerWaitOf(end: DeadEnd, ts: string): string | null {
    if (this.parts.events.routedByADecision(end.card))
      return null
    const head = end.pr === null ? null : currentHeadOf(this.db, end.pr)
    const lift: WaitLift = { on: DEAD_END_LIFTS, ...(head === null ? {} : { head }) }
    const ask = { need: 'decision' as const, text: deadEndWaitText(end), card: end.card, ...(end.pr === null ? {} : { pr: end.pr }), lift }
    return liftHeldAtOpen(this.db, ask) === null ? openOwnerWait(this.db, ts, DEAD_END_ACTOR, ask) : null
  }

  private windowCarriesAnOwnerAnswer(card: UnheldCard): boolean {
    if (!WINDOW_ACTIONS.includes(card.lastEvent.type))
      return false
    const asked = new Set(ofCard(this.db, card.card, { types: [OWNER_WAIT_OPENED] }).map(opened => opened.data?.id))
    return asked.size > 0 && events(this.db, { types: [OWNER_WAIT_CLOSED], before: card.lastEvent.id }).some(closed => asked.has(closed.data?.id))
  }

  private stoppedUnderAHold(card: UnheldCard): boolean {
    return card.state === STOPPED_CARD && holderOf(holdLayersOf(this.db, card.card)) !== null
  }

  private lastMoveIsItsOwnRejectedRaise(card: UnheldCard): boolean {
    if (card.lastEvent.type !== REJECTED)
      return false
    const rejected = ofCard(this.db, card.card, { types: [REJECTED], ids: [card.lastEvent.id] })[0]?.data?.event_id
    if (typeof rejected !== 'number')
      return false
    return ofCard(this.db, card.card, { types: RAISED_TYPES, ids: [rejected] }).some(raised => raised.actor === DEAD_END_ACTOR)
  }

  private stopReasonOf(card: UnheldCard): string | null {
    return card.state === STOPPED_CARD ? this.parts.events.lastStopReason(card.card) : null
  }

  private cardsUnderAnOpenOwnerWait(): Set<number> {
    const reduced = lastReducedOwnerWaits(this.db)
    const held = new Set(reduced.rows.flatMap(wait => wait.card === null ? [] : [wait.card]))
    if (reduced.behind !== null)
      this.parts.events.cardsOfUnclosedOwnerWaits().forEach(card => held.add(card))
    return held
  }
}

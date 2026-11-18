import type { DatabaseSync } from 'node:sqlite'
import type { Shape } from './expected-time.js'
import { CLOSED_CARD, DEFERRED_CARD, DROPPED_CARD, MERGED_CARD, QUEUED_CARD, STOPPED_CARD } from '../core/card-automaton.js'
import { appendEvent, CLOSED_WAIT, inTransaction, OPEN_WAIT, openOwnerWait, OWNER_WAITS } from '../core/db.js'
import { BOARD_ALARM, CARD_STOPPED, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED } from '../core/events.js'
import { expectedMinutes, RoundMeasures } from './expected-time.js'

export const DEAD_END = 'dead_end'
export const DEAD_END_ACTOR = 'worker:supervisor:dead-ends'
export const UNMEASURED_ROUND_MINUTES = 60
const MINUTE_MS = 60_000

export const HELD_ELSEWHERE_STATES: readonly string[] = [MERGED_CARD, CLOSED_CARD, DROPPED_CARD, QUEUED_CARD, DEFERRED_CARD]

export type MoversOf = (state: string, condition: string | null) => readonly string[]

const AN_OPEN_OWNER_WAIT_ON_THE_CARD = `(
  EXISTS (SELECT 1 FROM ${OWNER_WAITS} AS wait WHERE wait.card_id = cards.card_id AND wait.state = '${OPEN_WAIT}')
  OR EXISTS (
    SELECT 1 FROM events AS opened WHERE opened.type = '${OWNER_WAIT_OPENED}' AND opened.legacy = 0 AND opened.card_id = cards.card_id
      AND NOT EXISTS (SELECT 1 FROM ${OWNER_WAITS} AS settled WHERE settled.id = json_extract(opened.payload, '$.id') AND settled.state = '${CLOSED_WAIT}')
      AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${OWNER_WAIT_CLOSED}' AND json_extract(closed.payload, '$.id') = json_extract(opened.payload, '$.id'))
  )
)`

const CARDS_NOBODY_HOLDS = `
  SELECT cards.card_id, cards.state, cards.pr FROM cards
  WHERE cards.state IS NOT NULL AND cards.state NOT IN (${HELD_ELSEWHERE_STATES.map(state => `'${state}'`).join(', ')})
    AND NOT EXISTS (SELECT 1 FROM prs WHERE prs.card_id = cards.card_id AND prs.state = '${MERGED_CARD}')
    AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.card_id = cards.card_id AND tasks.state IN ('queued', 'leased'))
    AND NOT ${AN_OPEN_OWNER_WAIT_ON_THE_CARD}
  ORDER BY cards.card_id
`

const LAST_EVENT_OF_THE_CARD = `SELECT id, type, ts FROM events WHERE card_id = ? AND actor != '${DEAD_END_ACTOR}' ORDER BY id DESC LIMIT 1`

const LAST_STOP_REASON = `SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE type = '${CARD_STOPPED}' AND legacy = 0 AND card_id = ? ORDER BY id DESC LIMIT 1`

interface UnheldCard {
  card_id: number
  state: string
  pr: number | null
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
    ? `no node's queue candidates select a ${named} card`
    : `${movers.join(', ')} select a ${named} card, and none of them holds a live or queued task for #${end.card}, nor is an owner wait open on it`
  return `dead end: card #${end.card} is ${named}, last event ${end.lastEvent.type} #${end.lastEvent.id} ${end.idleMinutes} min ago, past its round time of ${end.roundMinutes} min for ${end.shape.size}/${end.shape.contour}; ${why}`
}

export function deadEndWaitText(end: DeadEnd): string {
  return `card #${end.card} is at a dead end in state ${stateNamed(end)}: ${end.reason}. Give it its route with an owner move, or decide which node moves a ${stateNamed(end)} card`
}

export class DeadEnds {
  private readonly measures: RoundMeasures

  constructor(private readonly db: DatabaseSync, private readonly clock: () => Date, private readonly moversOf: MoversOf) {
    this.measures = new RoundMeasures(db)
  }

  found(): DeadEnd[] {
    const now = this.clock().getTime()
    const unheld = this.db.prepare(CARDS_NOBODY_HOLDS).all() as unknown as UnheldCard[]
    if (unheld.length === 0)
      return []
    const samples = this.measures.samples()
    return unheld.flatMap((card) => {
      const lastEvent = this.db.prepare(LAST_EVENT_OF_THE_CARD).get(card.card_id) as LastEvent | undefined
      if (lastEvent === undefined)
        return []
      const shape = this.measures.shapeOfCard(card.card_id)
      const measured = [expectedMinutes(samples, 'answer', shape), expectedMinutes(samples, 'review', shape)].filter(minutes => minutes !== null)
      const roundMinutes = measured.length === 0 ? UNMEASURED_ROUND_MINUTES : Math.max(...measured)
      const idleMinutes = Math.floor((now - Date.parse(lastEvent.ts)) / MINUTE_MS)
      if (idleMinutes <= roundMinutes)
        return []
      const condition = this.stopReasonOf(card)
      const end = { card: card.card_id, pr: card.pr, state: card.state, condition, lastEvent, idleMinutes, roundMinutes, shape }
      return [{ ...end, reason: deadEndReason(end, this.moversOf(card.state, condition)) }]
    })
  }

  step(): string[] {
    const ts = this.clock().toISOString()
    return this.found().flatMap(end => inTransaction(this.db, () => {
      const raised = appendEvent(this.db, { ts, type: BOARD_ALARM, actor: DEAD_END_ACTOR, cardId: end.card, pr: end.pr, head: null, dedupeKey: `${BOARD_ALARM}:${DEAD_END}:${end.card}:${end.lastEvent.id}`, payload: { reason: end.reason, detail: DEAD_END }, legacy: false })
      if (!raised)
        return []
      const wait = openOwnerWait(this.db, ts, DEAD_END_ACTOR, { need: 'decision', text: deadEndWaitText(end), card: end.card, ...(end.pr === null ? {} : { pr: end.pr }) })
      return [`${BOARD_ALARM} #${end.card} ${end.reason}; owner wait ${wait}`]
    }))
  }

  private stopReasonOf(card: UnheldCard): string | null {
    if (card.state !== STOPPED_CARD)
      return null
    const stop = this.db.prepare(LAST_STOP_REASON).get(card.card_id) as { reason: unknown } | undefined
    return typeof stop?.reason === 'string' ? stop.reason : null
  }
}

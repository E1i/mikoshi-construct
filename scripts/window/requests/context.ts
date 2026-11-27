import type { DatabaseSync } from 'node:sqlite'
import type { bodyNotFoldedYet, GitHub } from './reach.js'
import type { Executed, RequestPayload, RequestTools } from './request.js'
import { cardsWithAState, heldCardOf } from '../../core/card-readings.js'
import { byId, EITHER_JOURNAL, events, latest } from '../../core/events-query.js'
import * as prs from '../../core/pr-readings.js'
import { startStillOpen } from '../window-session-end.js'
import { CARD_ANSWERED, CARD_CONTINUED, CARD_STARTED, CARD_STOPPED, decisionsInForceAt, holdLayersOf, legacyHistory, ownerHoldOf, PR_OBSERVED, REJECTED, sameDecisionWords, settledCards } from './reach.js'
import { ENDED_CARDS, flagsOf, liveTaskOf, messageOf } from './request.js'

export interface PrAsObserved {
  card_id: number | null
  head: string | null
  state: string | null
  event_id: number
  body_sha: string | null
}

export type CardBodiesBus = Parameters<typeof bodyNotFoldedYet>[0]

export type RequestExecutor = (context: RequestContext, request: number, payload: RequestPayload) => Executed

const TURNS = [CARD_STOPPED, CARD_ANSWERED, CARD_STARTED]

function cardStatesOf(db: DatabaseSync): Map<string, string> {
  return new Map([...cardsWithAState(db)].map(([card, state]) => [String(card), state]))
}

function rejectedEventsOf(db: DatabaseSync, cardId: number): Set<unknown> {
  return new Set(events(db, { types: [REJECTED], card: cardId, legacy: EITHER_JOURNAL }).map(rejection => rejection.data?.event_id))
}

export class RequestContext {
  constructor(readonly db: DatabaseSync, readonly clock: () => Date, readonly tools: RequestTools, readonly ownerChannel: string, readonly releaseVersion: () => string | null, readonly repository: string, readonly gitHub: GitHub, readonly bus: CardBodiesBus | null) {}

  now(): string {
    return this.clock().toISOString()
  }

  observed(pr: number): PrAsObserved | undefined {
    const recorded = prs.ofPr(this.db, pr)
    if (recorded === null)
      return undefined
    const row = { card_id: recorded.card_id, head: recorded.head, state: recorded.state, event_id: recorded.event_id, body_sha: recorded.body_sha }
    const fresh = latest(this.db, { types: [PR_OBSERVED], pr, withHead: true })
    if (fresh === null || fresh.id <= row.event_id)
      return row
    const state = fresh.data?.state
    return { ...row, head: fresh.head, state: typeof state === 'string' ? state : row.state }
  }

  actorOf(request: number): string {
    return byId(this.db, request)?.actor as string
  }

  latestTurn(cardId: number, skipRejectedStarts = false): { id: number, type: string } | undefined {
    const rejected = skipRejectedStarts ? rejectedEventsOf(this.db, cardId) : new Set<unknown>()
    const turn = events(this.db, { card: cardId, types: TURNS, newestFirst: true }).find(event => !rejected.has(event.id))
    return turn === undefined ? undefined : { id: turn.id, type: turn.type }
  }

  openSessionOf(cardId: number): number | null {
    const turn = this.latestTurn(cardId, true)
    return (turn?.type === CARD_STARTED || turn?.type === CARD_CONTINUED) && startStillOpen(this.db, cardId, turn.id) ? turn.id : null
  }

  routeOf(cardId: number, owner = false): string | null {
    const card = heldCardOf(this.db, cardId)
    if (ENDED_CARDS.has(card?.state) || (owner && card === null))
      return card === null ? `the bus holds no card #${cardId}; there is nothing to move` : `card #${cardId} is ${card.state}; there is nothing to ${owner ? 'move' : 'take over'}`
    if (owner)
      return null
    const layers = holdLayersOf(this.db, cardId)
    const hold = layers.owner === null || layers.takeover !== null ? ownerHoldOf(this.db, cardId) : null
    if (hold !== null)
      return `${hold}; release it before a takeover`
    const task = liveTaskOf(this.db, cardId)
    if (task !== null)
      return `card #${cardId} has a bus route: the ${task.queue} task ${task.task_key} is ${task.state}`
    const turn = this.latestTurn(cardId)
    if (turn?.type === CARD_STARTED && startStillOpen(this.db, cardId, turn.id))
      return `card #${cardId} has a bus route: its session started at event ${turn.id} has not ended`
    return null
  }

  settledFlags(): string[] {
    return flagsOf('--settled', [...settledCards(legacyHistory(this.db), cardStatesOf(this.db))].map(card => `#${card}`))
  }

  sameWordsBoundTo(words: string, cards: readonly number[]): number | null {
    if (cards.length === 0)
      return null
    const same = decisionsInForceAt(this.db, this.clock()).find(decision => sameDecisionWords(decision.text, words) && cards.every(card => decision.cards.includes(card)))
    return same?.decisionId ?? null
  }

  writtenDecision(args: string[]): { code: number, lines: string[] } {
    try {
      return this.tools.addDecision(args)
    }
    catch (error) {
      return { code: 1, lines: [`decisions:add failed: ${messageOf(error)}`] }
    }
  }
}

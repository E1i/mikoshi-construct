import type { DatabaseSync } from 'node:sqlite'
import type { GitHub } from './reach.js'
import type { Executed, RequestPayload, RequestTools } from './request.js'
import { startStillOpen } from '../window-session-end.js'
import { CARD_ANSWERED, CARD_CONTINUED, CARD_STARTED, CARD_STOPPED, decisionsInForceAt, holdLayersOf, legacyHistory, ownerHoldOf, PR_OBSERVED, REJECTED, sameDecisionWords, settledCards } from './reach.js'
import { ENDED_CARDS, flagsOf, LIVE_TASK_OF_CARD, messageOf } from './request.js'

export interface PrAsObserved {
  card_id: number | null
  head: string | null
  state: string | null
  event_id: number
}

export type RequestExecutor = (context: RequestContext, request: number, payload: RequestPayload) => Executed

const LATEST_OBSERVATION = `
  SELECT id, head, json_extract(payload, '$.state') AS state FROM events WHERE type = '${PR_OBSERVED}' AND legacy = 0 AND pr = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1
`

const LATEST_TURN = `SELECT id, type FROM events AS turn WHERE turn.card_id = ? AND turn.legacy = 0 AND turn.type IN ('${CARD_STOPPED}', '${CARD_ANSWERED}', '${CARD_STARTED}') AND (? = 0 OR NOT EXISTS (SELECT 1 FROM events AS rejection WHERE rejection.type = '${REJECTED}' AND rejection.card_id = turn.card_id AND json_extract(rejection.payload, '$.event_id') = turn.id)) ORDER BY turn.id DESC LIMIT 1`

function cardStatesOf(db: DatabaseSync): Map<string, string> {
  return new Map((db.prepare('SELECT card_id, state FROM cards WHERE state IS NOT NULL').all() as { card_id: number, state: string }[]).map(row => [String(row.card_id), row.state]))
}

export class RequestContext {
  constructor(readonly db: DatabaseSync, readonly clock: () => Date, readonly tools: RequestTools, readonly ownerChannel: string, readonly releaseVersion: () => string | null, readonly repository: string, readonly gitHub: GitHub) {}

  now(): string {
    return this.clock().toISOString()
  }

  observed(pr: number): PrAsObserved | undefined {
    const row = this.db.prepare('SELECT card_id, head, state, event_id FROM prs WHERE pr = ?').get(pr) as PrAsObserved | undefined
    const fresh = this.db.prepare(LATEST_OBSERVATION).get(pr) as { id: number, head: string, state: unknown } | undefined
    if (row === undefined || fresh === undefined || Number(fresh.id) <= Number(row.event_id))
      return row
    return { ...row, head: fresh.head, state: typeof fresh.state === 'string' ? fresh.state : row.state }
  }

  actorOf(request: number): string {
    return (this.db.prepare('SELECT actor FROM events WHERE id = ?').get(request) as { actor: string }).actor
  }

  latestTurn(cardId: number, skipRejectedStarts = false): { id: number, type: string } | undefined {
    return this.db.prepare(LATEST_TURN).get(cardId, Number(skipRejectedStarts)) as { id: number, type: string } | undefined
  }

  openSessionOf(cardId: number): number | null {
    const turn = this.latestTurn(cardId, true)
    return (turn?.type === CARD_STARTED || turn?.type === CARD_CONTINUED) && startStillOpen(this.db, cardId, turn.id) ? turn.id : null
  }

  routeOf(cardId: number, owner = false): string | null {
    const card = this.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string | null } | undefined
    if (ENDED_CARDS.has(card?.state) || (owner && card === undefined))
      return card === undefined ? `the bus holds no card #${cardId}; there is nothing to move` : `card #${cardId} is ${card.state}; there is nothing to ${owner ? 'move' : 'take over'}`
    if (owner)
      return null
    const layers = holdLayersOf(this.db, cardId)
    const hold = layers.owner === null || layers.takeover !== null ? ownerHoldOf(this.db, cardId) : null
    if (hold !== null)
      return `${hold}; release it before a takeover`
    const task = this.db.prepare(LIVE_TASK_OF_CARD).get(cardId) as { task_key: string, queue: string, state: string } | undefined
    if (task !== undefined)
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

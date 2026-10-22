import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { CommandResult, GitHub, GitHubPut } from './github.js'
import type { CloseRule, CloseVerdict } from './policy.js'
import { COMMAND_EXECUTED, POLICY_ALLOWED, POLICY_DENIED, PR_CLOSED } from '../core/events.js'
import { DROPPED_CARD } from './card-automaton.js'
import { appendEvent } from './db.js'
import { messageOf } from './errors.js'
import { leasedOn } from './lease.js'
import { CLOSE_RULES, closePolicy, RETRIED_CLOSE_RULES } from './policy.js'

export const CLOSE_COMMAND = 'close'
export const CLOSE_ACTOR = 'worker:close-pr:bus'
export const CLOSE_BY = ['window', 'card.dropped'] as const
const REPO = 'repos/{owner}/{repo}'
const MERGE_QUEUE = 'merge'

export type CloseBy = typeof CLOSE_BY[number]

export interface CloseRequest {
  attempt: string
  pr: number
  cardId: number
  reason: string
  by: CloseBy
}

export type CloseOutcome
  = | { kind: 'closed', pr: number, detail: string }
    | { kind: 'denied', pr: number, detail: string }
    | { kind: 'failed', pr: number, detail: string }

interface PullAsRead {
  state?: unknown
  body?: unknown
  head?: { ref?: unknown }
}

const OPEN_PRS_OF_DROPPED_CARDS = `
  SELECT prs.pr, prs.card_id, cards.event_id AS dropped FROM prs JOIN cards ON cards.card_id = prs.card_id
  WHERE prs.state = 'open' AND cards.state = '${DROPPED_CARD}'
    AND NOT EXISTS (SELECT 1 FROM events WHERE type = '${PR_CLOSED}' AND pr = prs.pr)
  ORDER BY prs.pr
`

export function droppedAttempt(droppedEventId: number, pr: number): string {
  return `dropped-${droppedEventId}-pr-${pr}`
}

export class PrCloser {
  constructor(private readonly db: DatabaseSync, private readonly gitHub: GitHub, private readonly patch: GitHubPut, private readonly clock: () => Date) {}

  close(request: CloseRequest): CloseOutcome {
    const read = this.read(request.pr)
    if (typeof read === 'string')
      return { kind: 'failed', pr: request.pr, detail: read }
    const verdict = closePolicy({ pr: request.pr, state: String(read.state ?? ''), headRef: String(read.head?.ref ?? ''), body: String(read.body ?? ''), cardId: request.cardId, mergeLeased: leasedOn(this.db, MERGE_QUEUE, request.pr) })
    if (verdict.kind === 'denied') {
      appendEvent(this.db, this.event(request, POLICY_DENIED, this.deniedKey(request, verdict.rule), { command: CLOSE_COMMAND, kind: 'authority', rule: verdict.rule, detail: verdict.detail, reason: request.reason, by: request.by }))
      return { kind: 'denied', pr: request.pr, detail: verdict.detail }
    }
    this.append(request, POLICY_ALLOWED, { command: CLOSE_COMMAND, rule: verdict.rule, reason: request.reason, by: request.by })
    return this.closed(request, verdict)
  }

  closeDropped(): CloseOutcome[] {
    const rows = this.db.prepare(OPEN_PRS_OF_DROPPED_CARDS).all() as { pr: number, card_id: number, dropped: number }[]
    return rows
      .map(row => ({ attempt: droppedAttempt(Number(row.dropped), Number(row.pr)), pr: Number(row.pr), cardId: Number(row.card_id), reason: `card #${row.card_id} was dropped`, by: 'card.dropped' as const }))
      .filter(request => !this.decided(request))
      .map(request => this.close(request))
  }

  private decided(request: CloseRequest): boolean {
    const lookup = this.db.prepare('SELECT 1 FROM events WHERE dedupe_key = ?')
    return CLOSE_RULES.some(rule => !RETRIED_CLOSE_RULES.has(rule) && lookup.get(this.deniedKey(request, rule)) !== undefined)
  }

  private deniedKey(request: CloseRequest, rule: CloseRule): string {
    return `${this.keyOf(POLICY_DENIED, request)}:${rule}`
  }

  private read(pr: number): PullAsRead | string {
    try {
      const response = this.gitHub(`${REPO}/pulls/${pr}`)
      return response.status === 200 && response.body !== null && typeof response.body === 'object' ? response.body as PullAsRead : `GitHub answered ${response.status} to the read of PR #${pr}`
    }
    catch (error) {
      return `the read of PR #${pr} failed: ${messageOf(error)}`
    }
  }

  private closed(request: CloseRequest, verdict: CloseVerdict): CloseOutcome {
    let result: CommandResult
    try {
      const response = this.patch(`${REPO}/pulls/${request.pr}`, { state: 'closed' })
      result = { ok: response.status === 200, status: response.status }
    }
    catch (error) {
      result = { ok: false, error: messageOf(error) }
    }
    this.append(request, COMMAND_EXECUTED, { command: CLOSE_COMMAND, ...result })
    if (!result.ok)
      return { kind: 'failed', pr: request.pr, detail: 'status' in result ? `GitHub answered ${result.status} to the close of PR #${request.pr}` : `the close of PR #${request.pr} failed: ${result.error}` }
    appendEvent(this.db, this.event(request, PR_CLOSED, `pr:${request.pr}:closed`, { merged: false, reason: request.reason, by: request.by }))
    return { kind: 'closed', pr: request.pr, detail: `closed PR #${request.pr} without merge, its branch kept: ${verdict.detail}` }
  }

  private keyOf(type: string, request: CloseRequest): string {
    return `${type}:${CLOSE_COMMAND}:${request.attempt}`
  }

  private append(request: CloseRequest, type: string, payload: Record<string, unknown>): void {
    appendEvent(this.db, this.event(request, type, this.keyOf(type, request), payload))
  }

  private event(request: CloseRequest, type: string, dedupeKey: string, payload: Record<string, unknown>): BusEvent {
    const actor = type === POLICY_ALLOWED || type === POLICY_DENIED ? 'policy' : CLOSE_ACTOR
    return { ts: this.clock().toISOString(), type, actor, cardId: request.cardId, pr: request.pr, head: null, dedupeKey, payload, legacy: false }
  }
}

import type { DatabaseSync } from 'node:sqlite'
import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { BusEvent } from '../../core/db.js'
import type { ReopenVerdict } from '../../policy/policy.js'
import type { CommandResult, GitHub, GitHubPut } from '../../ports/github.js'
import { appendEvent } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { COMMAND_EXECUTED, POLICY_ALLOWED, POLICY_DENIED } from '../../core/events.js'
import { reopenPolicy } from '../../policy/policy.js'
import { readPullOf } from './pr-close.js'

export const REOPEN_COMMAND = 'reopen'
export const REOPEN_ACTOR = 'worker:reopen-pr:bus'
const REPO = 'repos/{owner}/{repo}'
const CARD_STATE = 'SELECT state FROM cards WHERE card_id = ?'

export interface ReopenRequest {
  attempt: string
  pr: number
  cardId: number
  reason: string
}

export type ReopenOutcome
  = | { kind: 'reopened', pr: number, detail: string }
    | { kind: 'denied', pr: number, detail: string }
    | { kind: 'failed', pr: number, detail: string }

export class PrReopener {
  constructor(private readonly db: DatabaseSync, private readonly gitHub: GitHub, private readonly patch: GitHubPut, private readonly clock: () => Date, private readonly pushPolicy?: () => PushPolicy) {}

  reopen(request: ReopenRequest): ReopenOutcome {
    if (this.pushPolicy?.() === 'none')
      return { kind: 'denied', pr: request.pr, detail: `push policy none: the bus does not reopen PR #${request.pr}` }
    const read = readPullOf(this.gitHub, request.pr)
    if (typeof read === 'string')
      return { kind: 'failed', pr: request.pr, detail: read }
    const verdict = reopenPolicy({ pr: request.pr, state: String(read.state ?? ''), merged: read.merged === true, headRef: String(read.head?.ref ?? ''), body: String(read.body ?? ''), cardId: request.cardId, cardState: this.cardState(request.cardId) })
    if (verdict.kind === 'denied') {
      this.append(request, POLICY_DENIED, `${this.keyOf(POLICY_DENIED, request)}:${verdict.rule}`, { command: REOPEN_COMMAND, kind: 'authority', rule: verdict.rule, detail: verdict.detail, reason: request.reason })
      return { kind: 'denied', pr: request.pr, detail: verdict.detail }
    }
    this.append(request, POLICY_ALLOWED, this.keyOf(POLICY_ALLOWED, request), { command: REOPEN_COMMAND, rule: verdict.rule, reason: request.reason })
    return this.reopened(request, verdict)
  }

  private cardState(cardId: number): string | null {
    return (this.db.prepare(CARD_STATE).get(cardId) as { state: string | null } | undefined)?.state ?? null
  }

  private reopened(request: ReopenRequest, verdict: ReopenVerdict): ReopenOutcome {
    let result: CommandResult
    try {
      const response = this.patch(`${REPO}/pulls/${request.pr}`, { state: 'open' })
      result = { ok: response.status === 200, status: response.status }
    }
    catch (error) {
      result = { ok: false, error: messageOf(error) }
    }
    this.append(request, COMMAND_EXECUTED, this.keyOf(COMMAND_EXECUTED, request), { command: REOPEN_COMMAND, ...result })
    if (!result.ok)
      return { kind: 'failed', pr: request.pr, detail: 'status' in result ? `GitHub answered ${result.status} to the reopen of PR #${request.pr}` : `the reopen of PR #${request.pr} failed: ${result.error}` }
    return { kind: 'reopened', pr: request.pr, detail: `reopened PR #${request.pr}: ${verdict.detail}; netwatch observes it open on its next read` }
  }

  private keyOf(type: string, request: ReopenRequest): string {
    return `${type}:${REOPEN_COMMAND}:${request.attempt}`
  }

  private append(request: ReopenRequest, type: string, dedupeKey: string, payload: Record<string, unknown>): void {
    const event: BusEvent = { ts: this.clock().toISOString(), type, actor: type === COMMAND_EXECUTED ? REOPEN_ACTOR : 'policy', cardId: request.cardId, pr: request.pr, head: null, dedupeKey, payload, legacy: false }
    appendEvent(this.db, event)
  }
}

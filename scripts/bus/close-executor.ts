import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { GitHubPut } from './github.js'
import type { AfterFailure, Lease } from './lease.js'
import { VERIFICATION_WORDS } from '../board/verification.js'
import { messageOf } from './executor.js'
import { POLICY_DENIED } from './inbox.js'
import { assertHeld, completeTask, failTask, StaleLease } from './lease.js'
import { CARD_CLOSED } from './queue.js'

export const ISSUE_CLOSED_STATUS = 200
const REPO = 'repos/{owner}/{repo}'

export type CloseTechnicalReason = 'card_closed' | 'no_verification' | 'github_error'

export interface CloseDenial {
  kind: 'technical'
  reason: CloseTechnicalReason
  detail: string
}

export type CloseOutcome
  = | { kind: 'closed', taskKey: string, verification: string }
    | { kind: 'denied', taskKey: string, denial: CloseDenial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export type ReportedVerification = (cardId: number) => string | null

export interface CloseParts {
  db: DatabaseSync
  patch: GitHubPut
  reported: ReportedVerification
  clock: () => Date
}

class CardAlreadyClosed extends Error {}

function technical(reason: CloseTechnicalReason, detail: string): CloseDenial {
  return { kind: 'technical', reason, detail }
}

export function cardClosed(db: DatabaseSync, cardId: number): boolean {
  return db.prepare('SELECT 1 FROM events WHERE type = ? AND card_id = ? LIMIT 1').get(CARD_CLOSED, cardId) !== undefined
}

function isVerificationWord(word: string | null): word is string {
  return word !== null && (VERIFICATION_WORDS as readonly string[]).includes(word)
}

export class CloseExecutor {
  constructor(private readonly parts: CloseParts) {}

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  close(lease: Lease): CloseOutcome {
    try {
      assertHeld(this.parts.db, lease)
      if (cardClosed(this.parts.db, lease.cardId))
        return this.denied(lease, technical('card_closed', `card ${lease.cardId} is already closed`))
      const verification = this.parts.reported(lease.cardId)
      if (!isVerificationWord(verification))
        return this.denied(lease, technical('no_verification', `the run of card ${lease.cardId} reported ${verification === null ? 'no verification' : `'${verification}'`}, not one of ${VERIFICATION_WORDS.join(', ')}`))
      const refused = this.closeIssue(lease)
      if (refused !== null)
        return this.denied(lease, refused)
      return this.closed(lease, verification)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      if (error instanceof CardAlreadyClosed)
        return this.denied(lease, technical('card_closed', error.message))
      throw error
    }
  }

  private closeIssue(lease: Lease): CloseDenial | null {
    try {
      const response = this.parts.patch(`${REPO}/issues/${lease.cardId}`, { state: 'closed', state_reason: 'completed' })
      return response.status === ISSUE_CLOSED_STATUS ? null : technical('github_error', `GitHub answered ${response.status} to closing #${lease.cardId}`)
    }
    catch (error) {
      return technical('github_error', messageOf(error))
    }
  }

  private closed(lease: Lease, verification: string): CloseOutcome {
    const ts = this.ts()
    const event: BusEvent = { ts, type: CARD_CLOSED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CARD_CLOSED}:${lease.cardId}`, payload: { verification }, legacy: false }
    completeTask(this.parts.db, ts, lease, [event], (db) => {
      if (cardClosed(db, lease.cardId))
        throw new CardAlreadyClosed(`card ${lease.cardId} was closed while its issue was being closed`)
    })
    return { kind: 'closed', taskKey: lease.taskKey, verification }
  }

  private denied(lease: Lease, denial: CloseDenial): CloseOutcome {
    const ts = this.ts()
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'close', ...denial }, legacy: false }
    const next = failTask(this.parts.db, ts, lease, { reason: denial.reason, withdraw: denial.reason === 'card_closed' }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}

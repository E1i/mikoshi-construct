import type { DatabaseSync } from 'node:sqlite'
import type { MergeEvent } from '../board/handoff.js'
import type { CardFileStep } from './card-archive.js'
import type { BusEvent } from './db.js'
import type { AfterFailure, Lease } from './lease.js'
import { existsSync, readFileSync } from 'node:fs'
import { VERIFICATION_WORDS } from '../board/verification.js'
import { appendToJournal, hasMergeLine, journalLine } from '../ghosts/task-merged.js'
import { archiveCardFile } from './card-archive.js'
import { MERGE_DONE } from './executor.js'
import { POLICY_DENIED } from './inbox.js'
import { assertHeld, completeTask, failTask, StaleLease } from './lease.js'
import { CARD_CLOSED } from './queue.js'

export type CloseTechnicalReason = 'card_closed' | 'no_verification' | 'no_merge_commit'

export type MergeLineStep = 'written' | 'present'

export interface CloseCycle {
  mergeLine: MergeLineStep
  cardFile: CardFileStep
}

export interface CloseDenial {
  kind: 'technical'
  reason: CloseTechnicalReason
  detail: string
}

export type CloseOutcome
  = | { kind: 'closed', taskKey: string, verification: string, cycle: CloseCycle }
    | { kind: 'denied', taskKey: string, denial: CloseDenial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export type ReportedVerification = (cardId: number) => string | null

export interface CloseParts {
  db: DatabaseSync
  reported: ReportedVerification
  clock: () => Date
  journal: string
  parking: string
}

interface MergeRecord {
  actor: string
  ts: string
  payload: string
}

const MERGE_RECORD = `
  SELECT actor, ts, payload FROM events
  WHERE pr = ? AND (type = '${MERGE_DONE}' OR (type = 'pr.closed' AND json_extract(payload, '$.merged') = 1))
  ORDER BY CASE type WHEN '${MERGE_DONE}' THEN 0 ELSE 1 END, id LIMIT 1
`

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
      const merge = this.mergeLine(lease)
      if (merge === null)
        return this.denied(lease, technical('no_merge_commit', `the bus holds no merge commit for PR #${lease.pr}`))
      return this.closed(lease, verification, merge)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      if (error instanceof CardAlreadyClosed)
        return this.denied(lease, technical('card_closed', error.message))
      throw error
    }
  }

  private mergeLine(lease: Lease): MergeEvent | null {
    const record = lease.pr === null ? undefined : this.parts.db.prepare(MERGE_RECORD).get(lease.pr) as MergeRecord | undefined
    const commit = record === undefined ? undefined : (JSON.parse(record.payload) as { commit?: unknown }).commit
    if (record === undefined || typeof commit !== 'string')
      return null
    return { event: 'merge', task: String(lease.cardId), pr: lease.pr!, by: record.actor, commit, merged: record.ts, ts: this.ts() }
  }

  private appendMergeLine(line: MergeEvent): MergeLineStep {
    const { journal } = this.parts
    if (hasMergeLine(existsSync(journal) ? readFileSync(journal, 'utf8') : null, line.pr!))
      return 'present'
    appendToJournal(journal, journalLine(line))
    return 'written'
  }

  private closed(lease: Lease, verification: string, merge: MergeEvent): CloseOutcome {
    const mergeLine = this.appendMergeLine(merge)
    const cardFile = archiveCardFile(this.parts.parking, lease.cardId)
    const ts = this.ts()
    const event: BusEvent = { ts, type: CARD_CLOSED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CARD_CLOSED}:${lease.cardId}`, payload: { verification }, legacy: false }
    completeTask(this.parts.db, ts, lease, [event], (db) => {
      if (cardClosed(db, lease.cardId))
        throw new CardAlreadyClosed(`card ${lease.cardId} was closed before this close was recorded`)
    })
    return { kind: 'closed', taskKey: lease.taskKey, verification, cycle: { mergeLine, cardFile } }
  }

  private denied(lease: Lease, denial: CloseDenial): CloseOutcome {
    const ts = this.ts()
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'close', ...denial }, legacy: false }
    const next = failTask(this.parts.db, ts, lease, { reason: denial.reason, withdraw: denial.reason === 'card_closed' }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}

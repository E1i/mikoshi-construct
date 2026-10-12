import type { DatabaseSync } from 'node:sqlite'
import type { MergeEvent } from '../board/handoff.js'
import type { CardFileStep } from './card-archive.js'
import type { BusEvent } from './db.js'
import type { AfterFailure, Lease } from './lease.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { VERIFICATION_WORDS } from '../board/verification.js'
import { appendToJournal, hasMergeLine, journalLine } from '../ghosts/task-merged.js'
import { cardSessionOf } from './answer-source.js'
import { archiveCardFile } from './card-archive.js'
import { appendEvent } from './db.js'
import { MERGE_DONE } from './executor.js'
import { POLICY_DENIED } from './inbox.js'
import { assertHeld, completeTask, failTask, StaleLease } from './lease.js'
import { CARD_CLOSED } from './queue.js'
import { REVIEW_RECORDED } from './review-worker.js'

export type CloseTechnicalReason = 'card_closed' | 'no_verification' | 'no_merge_commit'

export type MergeLineStep = 'written' | 'present' | 'no-merger'

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

export type ReportedVerification = (cardId: number, pr: number | null) => string | null

const REVIEWED_VERIFICATION = 'review'

export const ARTIFACT_REMOVED = 'artifact.removed'

export interface RemovedTree {
  path: string
  dirty: number
}

export interface CardTreeRemover {
  remove: (worktree: string) => RemovedTree | null
}

export interface CloseParts {
  db: DatabaseSync
  reported: ReportedVerification
  clock: () => Date
  journal: string
  parking: string
  trees?: CardTreeRemover
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function canonical(dir: string): string {
  return existsSync(dir) ? realpathSync(dir) : dir
}

function listedWorktrees(repo: string): string[] {
  return git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
}

function dirtyCount(worktree: string): number {
  return existsSync(worktree) ? git(worktree, ['status', '--porcelain']).split('\n').filter(line => line !== '').length : 0
}

export function gitTreeRemover(repo: string): CardTreeRemover {
  return {
    remove: (worktree) => {
      const [, ...linked] = listedWorktrees(repo)
      const listed = linked.find(entry => canonical(entry) === canonical(worktree))
      if (listed === undefined)
        return null
      const dirty = dirtyCount(listed)
      git(repo, ['worktree', 'remove', '--force', listed])
      git(repo, ['worktree', 'prune'])
      return { path: listed, dirty }
    },
  }
}

interface MergeRecord {
  payload: string
}

interface Merger {
  by: unknown
  merged: unknown
}

const MERGE_RECORD = `
  SELECT payload FROM events
  WHERE pr = ? AND (type = '${MERGE_DONE}' OR (type = 'pr.closed' AND json_extract(payload, '$.merged') = 1))
  ORDER BY CASE type WHEN '${MERGE_DONE}' THEN 0 ELSE 1 END, id LIMIT 1
`

const OBSERVED_MERGER = `
  SELECT json_extract(payload, '$.merged_by') AS by, json_extract(payload, '$.merged_at') AS merged FROM events
  WHERE pr = ? AND type = 'pr.closed' AND json_extract(payload, '$.merged') = 1
  ORDER BY id LIMIT 1
`

const REVIEW_PASS_AT_HEAD = `
  SELECT 1 FROM events
  WHERE type = '${REVIEW_RECORDED}' AND legacy = 0 AND pr = ? AND json_extract(payload, '$.head') = ? AND json_extract(payload, '$.verdict') = 'pass'
  LIMIT 1
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
  private readonly trees: CardTreeRemover

  constructor(private readonly parts: CloseParts) {
    this.trees = parts.trees ?? gitTreeRemover(process.cwd())
  }

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  close(lease: Lease): CloseOutcome {
    try {
      assertHeld(this.parts.db, lease)
      if (cardClosed(this.parts.db, lease.cardId))
        return this.denied(lease, technical('card_closed', `card ${lease.cardId} is already closed`))
      const verification = this.parts.reported(lease.cardId, lease.pr) ?? this.reviewedHead(lease)
      if (!isVerificationWord(verification))
        return this.denied(lease, technical('no_verification', `card ${lease.cardId} has ${verification === null ? `no verification: no shift report, no task:close line for PR #${lease.pr} and no review pass at ${lease.head}` : `'${verification}'`}, not one of ${VERIFICATION_WORDS.join(', ')}`))
      const commit = this.mergeCommit(lease)
      if (commit === null)
        return this.denied(lease, technical('no_merge_commit', `the bus holds no merge commit for PR #${lease.pr}`))
      return this.closed(lease, verification, this.mergeLine(lease, commit))
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      if (error instanceof CardAlreadyClosed)
        return this.denied(lease, technical('card_closed', error.message))
      throw error
    }
  }

  private reviewedHead(lease: Lease): string | null {
    if (lease.pr === null || lease.head === null)
      return null
    return this.parts.db.prepare(REVIEW_PASS_AT_HEAD).get(lease.pr, lease.head) === undefined ? null : REVIEWED_VERIFICATION
  }

  private mergeCommit(lease: Lease): string | null {
    const record = lease.pr === null ? undefined : this.parts.db.prepare(MERGE_RECORD).get(lease.pr) as MergeRecord | undefined
    const commit = record === undefined ? undefined : (JSON.parse(record.payload) as { commit?: unknown }).commit
    return typeof commit === 'string' ? commit : null
  }

  private mergeLine(lease: Lease, commit: string): MergeEvent | null {
    const merger = this.parts.db.prepare(OBSERVED_MERGER).get(lease.pr) as Merger | undefined
    if (typeof merger?.by !== 'string' || typeof merger.merged !== 'string')
      return null
    return { event: 'merge', task: String(lease.cardId), pr: lease.pr!, by: merger.by, commit, merged: merger.merged, ts: this.ts() }
  }

  private appendMergeLine(pr: number, line: MergeEvent | null): MergeLineStep {
    const { journal } = this.parts
    if (hasMergeLine(existsSync(journal) ? readFileSync(journal, 'utf8') : null, pr))
      return 'present'
    if (line === null)
      return 'no-merger'
    appendToJournal(journal, journalLine(line))
    return 'written'
  }

  private closed(lease: Lease, verification: string, merge: MergeEvent | null): CloseOutcome {
    const mergeLine = this.appendMergeLine(lease.pr!, merge)
    const cardFile = archiveCardFile(this.parts.parking, lease.cardId)
    const ts = this.ts()
    const event: BusEvent = { ts, type: CARD_CLOSED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CARD_CLOSED}:${lease.cardId}`, payload: { verification }, legacy: false }
    completeTask(this.parts.db, ts, lease, [event], (db) => {
      if (cardClosed(db, lease.cardId))
        throw new CardAlreadyClosed(`card ${lease.cardId} was closed before this close was recorded`)
    })
    this.removeCardTree(lease)
    return { kind: 'closed', taskKey: lease.taskKey, verification, cycle: { mergeLine, cardFile } }
  }

  private removeCardTree(lease: Lease): void {
    const session = cardSessionOf(this.parts.db, lease.cardId)
    if (session === null)
      return
    let removed: RemovedTree | null
    try {
      removed = this.trees.remove(session.worktree)
    }
    catch {
      return
    }
    if (removed === null)
      return
    appendEvent(this.parts.db, { ts: this.ts(), type: ARTIFACT_REMOVED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${ARTIFACT_REMOVED}:${lease.cardId}:${removed.path}`, payload: { path: removed.path, by: lease.actor, dirty: removed.dirty }, legacy: false })
  }

  private denied(lease: Lease, denial: CloseDenial): CloseOutcome {
    const ts = this.ts()
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'close', ...denial }, legacy: false }
    const next = failTask(this.parts.db, ts, lease, { reason: denial.reason, withdraw: denial.reason === 'card_closed' }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}

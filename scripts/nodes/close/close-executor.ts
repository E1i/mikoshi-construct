import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../core/db.js'
import type { AfterFailure, Lease } from '../../core/lease.js'
import type { CardFileStep } from '../../intake/card-archive.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { appendEvent } from '../../core/db.js'
import { ARTIFACT_KEPT, ARTIFACT_REMOVED, CARD_CLOSED, CARD_VERIFIED, POLICY_DENIED } from '../../core/events.js'
import { assertHeld, completeTask, failTask, StaleLease } from '../../core/lease.js'
import { VERIFICATION_WORDS } from '../../core/verification.js'
import { archiveCardFile } from '../../intake/card-archive.js'
import { cardContract, NOT_MINE, notMine } from '../../intake/card-contract.js'
import { closeWitnessDenial, MERGE_RECORD, WITNESS_REASON } from '../../policy/policy.js'
import { cardSessionOf } from '../answer/answer-source.js'

export type CloseTechnicalReason = 'card_closed' | 'no_verification' | 'no_merge_commit' | typeof WITNESS_REASON | typeof NOT_MINE

export interface TreeLeft {
  path: string
  left: string
}

export interface CloseCycle {
  cardFile: CardFileStep
  treeLeft: TreeLeft | null
}

export interface CloseDenial {
  kind: 'technical'
  reason: CloseTechnicalReason
  detail: string
  base?: string
}

export type CloseOutcome
  = | { kind: 'closed', taskKey: string, verification: string, cycle: CloseCycle }
    | { kind: 'denied', taskKey: string, denial: CloseDenial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export type ReportedVerification = (cardId: number, pr: number | null) => string | null

export interface RemovedTree {
  path: string
  dirty: number
  kept: boolean
}

export interface CardTreeRemover {
  remove: (worktree: string) => RemovedTree | null
}

export interface CloseParts {
  db: DatabaseSync
  reported: ReportedVerification
  clock: () => Date
  parking: string
  trees?: CardTreeRemover
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function failureOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr
  const said = Buffer.isBuffer(stderr) || typeof stderr === 'string' ? String(stderr).trim() : ''
  return said !== '' ? said : error instanceof Error ? error.message : String(error)
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
      if (dirty > 0)
        return { path: listed, dirty, kept: true }
      git(repo, ['worktree', 'remove', '--force', listed])
      git(repo, ['worktree', 'prune'])
      return { path: listed, dirty, kept: false }
    },
  }
}

interface MergeRecord {
  payload: string
}

class CardAlreadyClosed extends Error {}

function technical(reason: CloseTechnicalReason, detail: string): CloseDenial {
  return { kind: 'technical', reason, detail }
}

export function cardClosed(db: DatabaseSync, cardId: number): boolean {
  return db.prepare('SELECT 1 FROM events WHERE type = ? AND card_id = ? LIMIT 1').get(CARD_CLOSED, cardId) !== undefined
}

const PROBE_CLOSINGS = `
  SELECT card_id, payload FROM events
  WHERE type = '${CARD_VERIFIED}' AND legacy = 0 AND pr IS NULL AND card_id IS NOT NULL
    AND json_extract(payload, '$.report') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${CARD_CLOSED}' AND closed.card_id = events.card_id)
  ORDER BY id
`

interface ProbeClosing {
  verification: string | null
  report: string
}

export function probeClosingCardIds(db: DatabaseSync): number[] {
  const rows = db.prepare(PROBE_CLOSINGS).all() as unknown as { card_id: number }[]
  return [...new Set(rows.map(row => row.card_id))]
}

function probeClosingOf(db: DatabaseSync, cardId: number): ProbeClosing {
  const rows = db.prepare(PROBE_CLOSINGS).all() as unknown as { card_id: number, payload: string }[]
  const row = rows.filter(each => each.card_id === cardId).at(-1)
  const payload = row === undefined ? {} : JSON.parse(row.payload) as { verification?: unknown, report?: unknown }
  return { verification: typeof payload.verification === 'string' ? payload.verification : null, report: typeof payload.report === 'string' ? payload.report : '' }
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
      const foreign = notMine(cardContract(this.parts.db, lease.cardId), 'close')
      if (foreign !== null)
        return this.denied(lease, technical(NOT_MINE, foreign))
      const probe = lease.pr === null ? probeClosingOf(this.parts.db, lease.cardId) : null
      const verification = probe === null ? this.parts.reported(lease.cardId, lease.pr) : probe.verification
      if (!isVerificationWord(verification))
        return this.denied(lease, technical('no_verification', `card ${lease.cardId} has ${verification === null ? `no verification: no card.verified for ${lease.pr === null ? 'its report' : `PR #${lease.pr}`}` : `'${verification}'`}, not one of ${VERIFICATION_WORDS.join(', ')}`))
      if (probe !== null)
        return this.closed(lease, verification, probe.report)
      if (this.mergeCommit(lease) === null)
        return this.denied(lease, technical('no_merge_commit', `the bus holds no merge commit for PR #${lease.pr}`))
      const unwitnessed = closeWitnessDenial(this.parts.db, lease.cardId, lease.pr, lease.head)
      if (unwitnessed !== null)
        return this.denied(lease, { ...technical(WITNESS_REASON, unwitnessed.detail), ...(unwitnessed.base === null ? {} : { base: unwitnessed.base }) })
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

  private mergeCommit(lease: Lease): string | null {
    const record = lease.pr === null ? undefined : this.parts.db.prepare(MERGE_RECORD).get(lease.pr) as MergeRecord | undefined
    const commit = record === undefined ? undefined : (JSON.parse(record.payload) as { commit?: unknown }).commit
    return typeof commit === 'string' ? commit : null
  }

  private closed(lease: Lease, verification: string, report?: string): CloseOutcome {
    const cardFile = archiveCardFile(this.parts.parking, lease.cardId)
    const ts = this.ts()
    const event: BusEvent = { ts, type: CARD_CLOSED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CARD_CLOSED}:${lease.cardId}`, payload: report === undefined ? { verification } : { verification, report }, legacy: false }
    completeTask(this.parts.db, ts, lease, [event], (db) => {
      if (cardClosed(db, lease.cardId))
        throw new CardAlreadyClosed(`card ${lease.cardId} was closed before this close was recorded`)
    })
    const treeLeft = this.removeCardTree(lease)
    return { kind: 'closed', taskKey: lease.taskKey, verification, cycle: { cardFile, treeLeft } }
  }

  private removeCardTree(lease: Lease): TreeLeft | null {
    const session = cardSessionOf(this.parts.db, lease.cardId)
    if (session === null)
      return null
    let removed: RemovedTree | null
    try {
      removed = this.trees.remove(session.worktree)
    }
    catch (error) {
      return { path: session.worktree, left: failureOf(error) }
    }
    if (removed === null)
      return null
    const type = removed.kept ? ARTIFACT_KEPT : ARTIFACT_REMOVED
    appendEvent(this.parts.db, { ts: this.ts(), type, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${type}:${lease.cardId}:${removed.path}`, payload: { path: removed.path, by: lease.actor, dirty: removed.dirty }, legacy: false })
    return null
  }

  private denied(lease: Lease, denial: CloseDenial): CloseOutcome {
    const ts = this.ts()
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'close', ...denial }, legacy: false }
    const next = failTask(this.parts.db, ts, lease, { reason: denial.reason, withdraw: denial.reason === 'card_closed' || denial.reason === NOT_MINE || denial.reason === WITNESS_REASON }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}

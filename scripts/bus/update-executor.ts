import type { DatabaseSync } from 'node:sqlite'
import type { ReviewStatus, StatusPublisher } from '../ghosts/verdict.js'
import type { BusEvent } from './db.js'
import type { GitHub, GitHubPut } from './github.js'
import type { AfterFailure, Lease } from './lease.js'
import type { TechnicalReason } from './record-verdict.js'
import type { VerdictOnHead } from './snapshot.js'
import { REVIEW_STATUS_CONTEXT } from '../ghosts/verdict.js'
import { messageOf } from './executor.js'
import { POLICY_DENIED } from './inbox.js'
import { assertHeld, completeTask, failTask, releaseTask, StaleLease } from './lease.js'
import { Meter } from './meter.js'
import { MAIN_BRANCH, MERGEABLE_OF_STATE, verdictOf } from './snapshot.js'

export const UPDATE_DONE = 'update.done'
export const UPDATED_STATUS = 202
export const STALE_HEAD_ON_UPDATE = 422
export const HEAD_READS = 5
const FILES_PAGE = 100
const REPO = 'repos/{owner}/{repo}'
const STATE_OF_VERDICT: Record<VerdictOnHead, ReviewStatus['state']> = { pass: 'success', changes: 'failure' }

export type UpdateTechnicalReason = TechnicalReason | 'not_mergeable' | 'not_behind' | 'wrong_base'

export interface UpdateDenial {
  kind: 'technical'
  reason: UpdateTechnicalReason
  detail: string
}

export type Carry = { carried: VerdictOnHead } | { carried: null, why: string }

export type UpdateOutcome
  = | { kind: 'updated', taskKey: string, from: string, to: string | null, carry: Carry }
    | { kind: 'denied', taskKey: string, denial: UpdateDenial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export interface UpdateParts {
  db: DatabaseSync
  gitHub: GitHub
  put: GitHubPut
  publish: StatusPublisher
  clock: () => Date
  settle: () => void
}

export interface DiffFile {
  filename: string
  status: string
  patch: string | null
}

export interface UpdatedHead {
  from: string
  to: string
  parents: string[]
  before: DiffFile[]
  after: DiffFile[]
}

interface Pull {
  state?: string
  mergeable_state?: string
  base?: { ref?: string }
  head?: { sha?: string }
}

interface Before {
  verdict: VerdictOnHead | null
  files: DiffFile[]
}

type Checked = { kind: 'ready', before: Before } | { kind: 'denied', denial: UpdateDenial }

const WAIT_REASONS: ReadonlySet<UpdateTechnicalReason> = new Set(['not_mergeable'])

function technical(reason: UpdateTechnicalReason, detail: string): UpdateDenial {
  return { kind: 'technical', reason, detail }
}

function sameDiff(before: DiffFile[], after: DiffFile[]): boolean {
  const key = (files: DiffFile[]): string => JSON.stringify(files.map(file => [file.filename, file.status, file.patch]).sort())
  return key(before) === key(after)
}

export function cleanUpdate(head: UpdatedHead): string | null {
  if (head.parents.length !== 2 || head.parents[0] !== head.from)
    return `${head.to} is not a merge of the base into ${head.from} (parents ${head.parents.join(', ') || 'none'})`
  if (head.before.some(file => file.patch === null) || head.after.some(file => file.patch === null))
    return `a file of the pull request carries no patch, so its own diff cannot be compared`
  if (!sameDiff(head.before, head.after))
    return `the merge into ${head.to} changed the pull request's own diff`
  return null
}

function diffOf(meter: Meter, pr: number): DiffFile[] {
  const files: DiffFile[] = []
  for (let page = 1; ; page += 1) {
    const listed = meter.get(`${REPO}/pulls/${pr}/files?per_page=${FILES_PAGE}&page=${page}`) as { filename?: string, status?: string, patch?: string }[]
    files.push(...listed.flatMap(file => file.filename === undefined ? [] : [{ filename: file.filename, status: file.status ?? '', patch: file.patch ?? null }]))
    if (listed.length < FILES_PAGE)
      return files
  }
}

function parentsOf(meter: Meter, commit: string): string[] {
  const parents = (meter.get(`${REPO}/commits/${commit}`) as { parents?: { sha?: string }[] }).parents ?? []
  return parents.flatMap(parent => parent.sha === undefined ? [] : [parent.sha])
}

export class UpdateExecutor {
  constructor(private readonly parts: UpdateParts) {}

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  private meter(): Meter {
    return new Meter(this.parts.gitHub, () => this.parts.clock().getTime())
  }

  update(lease: Lease): UpdateOutcome {
    try {
      assertHeld(this.parts.db, lease)
      const checked = this.fresh(lease)
      if (checked.kind === 'denied')
        return this.denied(lease, checked.denial)
      const refused = this.requested(lease)
      if (refused !== null)
        return this.denied(lease, refused)
      return this.updated(lease, checked.before)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private fresh(lease: Lease): Checked {
    const meter = this.meter()
    try {
      const pull = meter.get(`${REPO}/pulls/${lease.pr}`) as Pull
      if (pull.state !== 'open' || pull.head?.sha !== lease.head)
        return { kind: 'denied', denial: technical('stale_head', `#${lease.pr} is ${pull.state ?? 'unknown'} at ${pull.head?.sha ?? 'no head'}, the lease is for ${lease.head}`) }
      if (pull.base?.ref !== MAIN_BRANCH)
        return { kind: 'denied', denial: technical('wrong_base', `#${lease.pr} targets ${pull.base?.ref ?? 'no base'}, not ${MAIN_BRANCH}`) }
      const mergeable = MERGEABLE_OF_STATE[pull.mergeable_state ?? '']
      if (mergeable === undefined)
        return { kind: 'denied', denial: technical('not_mergeable', `#${lease.pr} is ${pull.mergeable_state ?? 'not computed yet'}`) }
      if (mergeable !== 'behind')
        return { kind: 'denied', denial: technical('not_behind', `#${lease.pr} is ${mergeable}, not behind`) }
      return { kind: 'ready', before: { verdict: verdictOf(meter, lease.head!), files: diffOf(meter, lease.pr!) } }
    }
    catch (error) {
      return { kind: 'denied', denial: technical('github_error', messageOf(error)) }
    }
  }

  private requested(lease: Lease): UpdateDenial | null {
    try {
      const response = this.parts.put(`${REPO}/pulls/${lease.pr}/update-branch`, { expected_head_sha: lease.head! })
      if (response.status === STALE_HEAD_ON_UPDATE)
        return technical('stale_head', `GitHub answered ${response.status}: the head of #${lease.pr} is no longer ${lease.head}`)
      return response.status === UPDATED_STATUS ? null : technical('github_error', `GitHub answered ${response.status} to the update of #${lease.pr}`)
    }
    catch (error) {
      return technical('github_error', messageOf(error))
    }
  }

  private newHead(lease: Lease): string | null {
    for (let read = 0; read < HEAD_READS; read += 1) {
      if (read > 0)
        this.parts.settle()
      try {
        const head = (this.meter().get(`${REPO}/pulls/${lease.pr}`) as Pull).head?.sha
        if (head !== undefined && head !== lease.head)
          return head
      }
      catch {}
    }
    return null
  }

  private carry(lease: Lease, before: Before, to: string | null): Carry {
    if (to === null)
      return { carried: null, why: `the head of #${lease.pr} had not moved after ${HEAD_READS} reads` }
    if (before.verdict === null)
      return { carried: null, why: `${lease.head} had no verdict to carry` }
    let unclean: string | null
    try {
      const meter = this.meter()
      unclean = cleanUpdate({ from: lease.head!, to, parents: parentsOf(meter, to), before: before.files, after: diffOf(meter, lease.pr!) })
    }
    catch (error) {
      unclean = messageOf(error)
    }
    if (unclean !== null)
      return { carried: null, why: unclean }
    assertHeld(this.parts.db, lease)
    try {
      this.parts.publish({ commit: to, state: STATE_OF_VERDICT[before.verdict], context: REVIEW_STATUS_CONTEXT, description: `carried from ${lease.head} by a clean update-branch` })
    }
    catch (error) {
      return { carried: null, why: messageOf(error) }
    }
    return { carried: before.verdict }
  }

  private updated(lease: Lease, before: Before): UpdateOutcome {
    const to = this.newHead(lease)
    const carry = this.carry(lease, before, to)
    const event: BusEvent = { ts: this.ts(), type: UPDATE_DONE, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${UPDATE_DONE}:${lease.taskKey}`, payload: { from: lease.head, to, ...carry }, legacy: false }
    completeTask(this.parts.db, this.ts(), lease, [event])
    return { kind: 'updated', taskKey: lease.taskKey, from: lease.head!, to, carry }
  }

  private denied(lease: Lease, denial: UpdateDenial): UpdateOutcome {
    const ts = this.ts()
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'update_branch', ...denial }, legacy: false }
    if (WAIT_REASONS.has(denial.reason)) {
      releaseTask(this.parts.db, ts, lease, denial.reason, [event])
      return { kind: 'denied', taskKey: lease.taskKey, denial, next: 'queued' }
    }
    const next = failTask(this.parts.db, ts, lease, { reason: denial.reason, withdraw: false }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}

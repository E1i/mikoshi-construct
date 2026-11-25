import type { DatabaseSync } from 'node:sqlite'
import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { BusEvent } from '../../core/db.js'
import type { EventRow } from '../../core/events-query.js'
import type { AfterFailure, CardTransitions, Lease } from '../../core/lease.js'
import type { CardFields } from '../../intake/card-contract.js'
import type { ReviewStatus, StatusPublisher } from '../../ports/github-status.js'
import type { CommandResult, GitHub, GitHubPut } from '../../ports/github.js'
import type { MergeMain } from '../../ports/main-merge.js'
import type { VerdictOnHead } from '../../ports/snapshot.js'
import type { TechnicalReason } from '../review/record-verdict.js'
import type { UpdateSourceParts } from './update-candidates.js'
import { Buffer } from 'node:buffer'
import { NOT_MINE, notMine } from '../../core/card-automaton.js'
import { pathsOutsideTheBody } from '../../core/card-bodies.js'
import { closedWaitIds, closedWaitTextsOf } from '../../core/card-readings.js'
import { appendEvent, openBusWait } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { ofPr as eventsOfPr } from '../../core/events-query.js'
import { CI_RERUN_REQUESTED, COMMAND_EXECUTED, POLICY_ALLOWED, POLICY_DENIED, QUESTION_OWNER, REVIEW_RECORDED, UPDATE_DONE } from '../../core/events.js'
import { assertHeld, completeTask, failTask, releaseTask, StaleLease } from '../../core/lease.js'
import { rerunDueOn } from '../../core/observations.js'
import { ofPr } from '../../core/pr-readings.js'
import { KEPT_BY_PUSH_POLICY } from '../../core/push-policy.js'
import { COMPLETED, keyOf, MERGE_REFUSED } from '../../core/queue.js'
import { cardContract } from '../../intake/card-contract.js'
import { growthAskedBefore } from '../../policy/derived-files.js'
import { rerunFailedJobsEndpoint, runsOnHeadEndpoint } from '../../ports/ci-reading.js'
import { REVIEW_STATUS_CONTEXT } from '../../ports/github-status.js'
import { conflictingCardOf } from '../../ports/main-merge.js'
import { Meter } from '../../ports/meter.js'
import { CANCELLED, MAIN_BRANCH, MERGEABLE_OF_STATE, verdictOf } from '../../ports/snapshot.js'
import { pollHead } from './head-poll.js'
import { updateCandidates } from './update-candidates.js'

export const UPDATED_STATUS = 202
export const STALE_HEAD_ON_UPDATE = 422
export const HEAD_READS = 5
export const RERUN_ACCEPTED = 201
const RERUN_CONCLUSIONS: ReadonlySet<unknown> = new Set([CANCELLED, 'failure', 'timed_out'])
const FILES_PAGE = 100
const REPO = 'repos/{owner}/{repo}'
const STATE_OF_VERDICT: Record<VerdictOnHead, ReviewStatus['state']> = { pass: 'success', changes: 'failure' }

const UPDATE_COMMAND = 'update_branch'
const MERGE_MAIN_COMMAND = 'merge_main'
const RATCHET_THRESHOLD_COMMAND = 'ratchet_threshold'
export const RATCHET_RECORD_PATH = 'contract/ratchet.json'
const CONTENT_WRITTEN: ReadonlySet<number> = new Set([200, 201])

export type UpdateCommand = typeof UPDATE_COMMAND | typeof MERGE_MAIN_COMMAND | typeof RATCHET_THRESHOLD_COMMAND | 'publish'

export interface ThresholdSet {
  row: string
  to: number
  decision: string
}

export function raisedRatchet(recorded: string, sets: readonly ThresholdSet[]): string | null {
  const numbers = JSON.parse(recorded) as Record<string, number>
  const raised = sets.filter(set => (numbers[set.row] ?? 0) < set.to)
  if (raised.length === 0)
    return null
  for (const set of raised)
    numbers[set.row] = Math.max(numbers[set.row] ?? 0, set.to)
  return `${JSON.stringify(Object.fromEntries(Object.keys(numbers).sort().map(key => [key, numbers[key]!])), null, 2)}\n`
}

interface RecordedContent {
  content?: string
  sha?: string
}

export const DERIVED_REFUSED = 'derived_refused'

export interface DerivedHold {
  kind: 'refused' | 'grown'
  detail: string
}

export type DerivedHolds = (cardId: number, scope: { touches: readonly string[], creates: readonly string[] }, files: readonly string[]) => DerivedHold | null

export type UpdateTechnicalReason = TechnicalReason | 'not_mergeable' | 'not_behind' | 'wrong_base' | typeof MERGE_REFUSED | typeof NOT_MINE | typeof KEPT_BY_PUSH_POLICY | typeof DERIVED_REFUSED

export interface UpdateDenial {
  kind: 'technical'
  reason: UpdateTechnicalReason
  detail: string
}

export type Carry = ({ carried: VerdictOnHead, rules_version: number | null } | { carried: null, why: string }) & { clean: boolean }

export type UpdateOutcome
  = | { kind: 'updated', taskKey: string, from: string, to: string | null, carry: Carry }
    | { kind: 'denied', taskKey: string, denial: UpdateDenial, next: AfterFailure | typeof COMPLETED }
    | { kind: 'stopped', taskKey: string, reason: typeof QUESTION_OWNER, detail: string }
    | { kind: 'fenced', taskKey: string }
    | { kind: 'rerun', taskKey: string, requested: boolean, detail: string }

export interface RerunRequest {
  requested: boolean
  detail: string
  runs: number[]
}

export interface UpdateParts {
  db: DatabaseSync
  cards: CardTransitions
  gitHub: GitHub
  put: GitHubPut
  publish: StatusPublisher
  clock: () => Date
  settle: () => void
  silentMs: number
  pushPolicy?: () => PushPolicy
  mergeMain?: MergeMain
  post?: GitHubPut
  thresholds?: (cardId: number) => readonly ThresholdSet[]
  derived?: DerivedHolds
  source: UpdateSourceParts
}

export interface ManualUpdate {
  ts: string
  session: string
  cardId: number
  pr: number
  from: string
  to: string
}

export interface RecordedVerdict {
  verdict: string
  rulesVersion: number | null
}

function recordsAVerdictOn(head: string): (row: EventRow) => boolean {
  return row => row.type === REVIEW_RECORDED ? row.head === head : row.data?.to === head && row.data.carried !== undefined && row.data.carried !== null
}

export function recordedVerdictOn(db: DatabaseSync, pr: number, head: string): RecordedVerdict | null {
  const row = eventsOfPr(db, pr, { types: [REVIEW_RECORDED, UPDATE_DONE], newestFirst: true }).find(recordsAVerdictOn(head))
  if (row === undefined)
    return null
  const payload = JSON.parse(row.payload) as { verdict?: unknown, carried?: unknown, rules_version?: unknown }
  const verdict = row.type === REVIEW_RECORDED ? payload.verdict : payload.carried
  return typeof verdict === 'string' ? { verdict, rulesVersion: typeof payload.rules_version === 'number' ? payload.rules_version : null } : null
}

export const MANUAL_UPDATE_WHY = 'a manual update-branch the window checked clean'

export function manualUpdateDone(update: ManualUpdate): BusEvent {
  const { from, to } = update
  return { ts: update.ts, type: UPDATE_DONE, actor: `worker:update:${update.session}`, cardId: update.cardId, pr: update.pr, head: from, dedupeKey: `${UPDATE_DONE}:manual:${update.pr}:${from}:${to}`, payload: { from, to, carried: null, why: MANUAL_UPDATE_WHY, clean: true }, legacy: false }
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
  base?: { ref?: string, sha?: string }
  head?: { sha?: string }
}

interface Before {
  verdict: VerdictOnHead | null
  files: DiffFile[]
}

type Checked = { kind: 'ready', before: Before } | { kind: 'conflicting' } | { kind: 'denied', denial: UpdateDenial }

const WAIT_REASONS: ReadonlySet<UpdateTechnicalReason> = new Set(['not_mergeable'])
const WITHDRAWN_REASONS: ReadonlySet<UpdateTechnicalReason> = new Set([NOT_MINE, KEPT_BY_PUSH_POLICY, MERGE_REFUSED, DERIVED_REFUSED])

function insideTheTouchesLine(lease: Lease, files: readonly string[]): string {
  return `pull request #${lease.pr} conflicts with ${MAIN_BRANCH} at ${lease.head} inside the card's own touches: ${files.join(', ')}; the conflict is the card's own (D-441, Q267), so it goes to the answer session to merge ${MAIN_BRANCH} keeping both sides, not to the owner`
}

function technical(reason: UpdateTechnicalReason, detail: string): UpdateDenial {
  return { kind: 'technical', reason, detail }
}

const HUNK_OFFSETS = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm

export function withoutHunkOffsets(patch: string | null): string | null {
  return patch === null ? null : patch.replace(HUNK_OFFSETS, '@@')
}

function sameDiff(before: DiffFile[], after: DiffFile[]): boolean {
  const key = (files: DiffFile[]): string => JSON.stringify(files.map(file => [file.filename, file.status, withoutHunkOffsets(file.patch)]).sort())
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
      if (this.parts.pushPolicy?.() === 'none')
        return this.denied(lease, this.rerunRefused(lease, technical(KEPT_BY_PUSH_POLICY, `push policy none: the bus does not update #${lease.pr}`)))
      const card = cardContract(this.parts.db, lease.cardId)
      const foreign = notMine(card, 'update')
      if (foreign !== null)
        return this.denied(lease, this.rerunRefused(lease, technical(NOT_MINE, foreign)))
      const thresholds = card === null ? null : this.thresholdsWritten(lease, card)
      if (thresholds !== null)
        return thresholds
      const rerun = this.rerunWhenDue(lease)
      if (rerun !== null)
        return rerun
      const gone = this.noLongerDue(lease)
      if (gone !== null)
        return this.denied(lease, gone)
      const checked = this.fresh(lease)
      if (checked.kind === 'denied')
        return this.denied(lease, checked.denial)
      const derived = card === null ? null : this.derivedHeld(lease, card, checked)
      if (derived !== null)
        return derived
      if (checked.kind === 'conflicting')
        return this.conflicting(lease, card)
      this.allowed(lease)
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

  private derivedHeld(lease: Lease, card: CardFields, checked: Exclude<Checked, { kind: 'denied' }>): UpdateOutcome | null {
    if (this.parts.derived === undefined)
      return null
    let files: string[]
    try {
      files = (checked.kind === 'ready' ? checked.before.files : diffOf(this.meter(), lease.pr!)).map(file => file.filename)
    }
    catch (error) {
      return this.denied(lease, technical('github_error', messageOf(error)))
    }
    const hold = this.parts.derived(lease.cardId, card, files)
    if (hold === null || (hold.kind === 'grown' && growthAskedBefore(hold.detail, closedWaitTextsOf(this.parts.db, lease.cardId))))
      return null
    const detail = `pull request #${lease.pr} at ${lease.head}: ${hold.detail}`
    return hold.kind === 'refused' ? this.denied(lease, technical(DERIVED_REFUSED, detail)) : this.grownForTheOwner(lease, detail)
  }

  private grownForTheOwner(lease: Lease, detail: string): UpdateOutcome {
    const ts = this.ts()
    openBusWait(this.parts.db, closedWaitIds(this.parts.db), ts, lease.actor, { need: 'decision', text: `card #${lease.cardId}, ${detail}`, card: lease.cardId, ...(lease.pr === null ? {} : { pr: lease.pr }) })
    completeTask(this.parts.db, this.parts.cards, ts, lease, [])
    return { kind: 'stopped', taskKey: lease.taskKey, reason: QUESTION_OWNER, detail }
  }

  private noLongerDue(lease: Lease): UpdateDenial | null {
    if (updateCandidates(this.parts.db, this.ts(), this.parts.source).some(task => keyOf(task) === lease.taskKey))
      return null
    return technical('not_behind', `${lease.taskKey} is no longer an update candidate: #${lease.pr} is not the turn of its group, or nothing it needs an update for holds any more`)
  }

  private thresholdsWritten(lease: Lease, card: CardFields): UpdateOutcome | null {
    const sets = this.parts.thresholds?.(lease.cardId) ?? []
    if (sets.length === 0)
      return null
    const endpoint = `${REPO}/contents/${RATCHET_RECORD_PATH}`
    const where = `${RATCHET_RECORD_PATH} on ${card.branch}`
    let recorded: RecordedContent
    try {
      recorded = this.meter().get(`${endpoint}?ref=${card.branch}`) as RecordedContent
    }
    catch (error) {
      return this.denied(lease, technical('github_error', `${where} could not be read: ${messageOf(error)}`))
    }
    if (recorded.content === undefined || recorded.sha === undefined)
      return this.denied(lease, technical('github_error', `${where} came back with no content or sha`))
    const raised = raisedRatchet(Buffer.from(recorded.content, 'base64').toString('utf8'), sets)
    if (raised === null)
      return null
    const decisions = [...new Set(sets.map(set => set.decision))].join(', ')
    this.allowed(lease, RATCHET_THRESHOLD_COMMAND)
    let response
    try {
      response = this.parts.put(endpoint, { message: `ratchet: the threshold the owner set in ${decisions}`, content: Buffer.from(raised).toString('base64'), sha: recorded.sha, branch: card.branch })
    }
    catch (error) {
      this.executed(lease, RATCHET_THRESHOLD_COMMAND, { ok: false, error: messageOf(error) })
      return this.denied(lease, technical('github_error', `${where} could not be written: ${messageOf(error)}`))
    }
    const to = CONTENT_WRITTEN.has(response.status) ? (response.body as { commit?: { sha?: string } } | null)?.commit?.sha : undefined
    this.executed(lease, RATCHET_THRESHOLD_COMMAND, { ok: to !== undefined, status: response.status })
    if (to === undefined)
      return this.denied(lease, technical('github_error', `GitHub answered ${response.status} to the write of ${where}`))
    return this.done(lease, to, { carried: null, why: `${RATCHET_RECORD_PATH} written with the threshold the owner set in ${decisions}`, clean: false })
  }

  private done(lease: Lease, to: string | null, carry: Carry): UpdateOutcome {
    const event: BusEvent = { ts: this.ts(), type: UPDATE_DONE, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${UPDATE_DONE}:${lease.taskKey}`, payload: { from: lease.head, to, ...carry, task_key: lease.taskKey, lease_gen: lease.leaseGen }, legacy: false }
    completeTask(this.parts.db, this.parts.cards, this.ts(), lease, [event])
    return { kind: 'updated', taskKey: lease.taskKey, from: lease.head!, to, carry }
  }

  private rerunDue(lease: Lease): boolean {
    return lease.pr !== null && lease.head !== null && rerunDueOn(this.parts.db, ofPr(this.parts.db, lease.pr), lease.head)
  }

  private rerunEvent(lease: Lease, request: RerunRequest): BusEvent {
    return { ts: this.ts(), type: CI_RERUN_REQUESTED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CI_RERUN_REQUESTED}:${lease.pr}:${lease.head}`, payload: { ...request, task_key: lease.taskKey, lease_gen: lease.leaseGen }, legacy: false }
  }

  private rerunRefused(lease: Lease, denial: UpdateDenial): UpdateDenial {
    if (this.rerunDue(lease))
      appendEvent(this.parts.db, this.rerunEvent(lease, { requested: false, detail: `no re-run of the cancelled jobs: ${denial.detail}`, runs: [] }))
    return denial
  }

  private rerunWhenDue(lease: Lease): UpdateOutcome | null {
    if (!this.rerunDue(lease))
      return null
    const request = this.rerunRequest(lease)
    const event = this.rerunEvent(lease, request)
    if (this.conflictingAt(lease)) {
      appendEvent(this.parts.db, event)
      return null
    }
    completeTask(this.parts.db, this.parts.cards, this.ts(), lease, [event])
    return { kind: 'rerun', taskKey: lease.taskKey, requested: request.requested, detail: request.detail }
  }

  private conflictingAt(lease: Lease): boolean {
    const pr = lease.pr === null ? null : ofPr(this.parts.db, lease.pr)
    return lease.head !== null && pr?.head === lease.head && pr.mergeable === 'dirty'
  }

  private rerunRequest(lease: Lease): RerunRequest {
    const post = this.parts.post
    if (post === undefined)
      return { requested: false, detail: `the update node holds no POST port, so the cancelled jobs on ${lease.head} are not re-run`, runs: [] }
    let runs: number[]
    try {
      const listed = (this.meter().get(runsOnHeadEndpoint(lease.head!)) as { workflow_runs?: { id?: unknown, conclusion?: unknown }[] }).workflow_runs ?? []
      runs = listed.filter(run => RERUN_CONCLUSIONS.has(run.conclusion) && typeof run.id === 'number').map(run => run.id as number)
    }
    catch (error) {
      return { requested: false, detail: `the runs on ${lease.head} could not be read: ${messageOf(error)}`, runs: [] }
    }
    if (runs.length === 0)
      return { requested: false, detail: `no run on ${lease.head} of #${lease.pr} ended cancelled or failed, so nothing is re-run`, runs }
    for (const run of runs) {
      try {
        const response = post(rerunFailedJobsEndpoint(run), {})
        if (response.status !== RERUN_ACCEPTED)
          return { requested: false, detail: `GitHub answered ${response.status} to the re-run of the failed jobs of run ${run} on #${lease.pr}`, runs }
      }
      catch (error) {
        return { requested: false, detail: `the re-run of the failed jobs of run ${run} on #${lease.pr} failed: ${messageOf(error)}`, runs }
      }
    }
    return { requested: true, detail: `re-ran the failed jobs of runs ${runs.join(', ')} on ${lease.head} of #${lease.pr}, whose red was only cancelled checks`, runs }
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
      if (mergeable === 'dirty' && this.parts.mergeMain !== undefined)
        return { kind: 'conflicting' }
      if (mergeable === 'dirty')
        return { kind: 'denied', denial: technical('not_behind', `#${lease.pr} is dirty, and this update node merges no main into a card tree, so an update-branch cannot take it`) }
      return { kind: 'ready', before: { verdict: verdictOf(meter, lease.head!), files: diffOf(meter, lease.pr!) } }
    }
    catch (error) {
      return { kind: 'denied', denial: technical('github_error', messageOf(error)) }
    }
  }

  private requested(lease: Lease): UpdateDenial | null {
    let response
    try {
      response = this.parts.put(`${REPO}/pulls/${lease.pr}/update-branch`, { expected_head_sha: lease.head! })
    }
    catch (error) {
      this.executed(lease, UPDATE_COMMAND, { ok: false, error: messageOf(error) })
      return technical('github_error', messageOf(error))
    }
    this.executed(lease, UPDATE_COMMAND, { ok: response.status === UPDATED_STATUS, status: response.status })
    if (response.status === STALE_HEAD_ON_UPDATE)
      return technical('stale_head', `GitHub answered ${response.status}: the head of #${lease.pr} is no longer ${lease.head}`)
    return response.status === UPDATED_STATUS ? null : technical('github_error', `GitHub answered ${response.status} to the update of #${lease.pr}`)
  }

  private newHead(lease: Lease): string | null {
    const poll = pollHead({
      from: lease.head!,
      read: () => (this.meter().get(`${REPO}/pulls/${lease.pr}`) as Pull).head?.sha,
      settle: () => this.parts.settle(),
      reads: HEAD_READS,
    })
    return poll.kind === 'moved' ? poll.head : null
  }

  private unclean(lease: Lease, before: Before, to: string): string | null {
    try {
      const meter = this.meter()
      return cleanUpdate({ from: lease.head!, to, parents: parentsOf(meter, to), before: before.files, after: diffOf(meter, lease.pr!) })
    }
    catch (error) {
      return messageOf(error)
    }
  }

  private carry(lease: Lease, before: Before, to: string | null): Carry {
    if (to === null)
      return { carried: null, why: `the head of #${lease.pr} had not moved after ${HEAD_READS} reads`, clean: false }
    const unclean = this.unclean(lease, before, to)
    if (unclean !== null)
      return { carried: null, why: unclean, clean: false }
    if (before.verdict === null)
      return { carried: null, why: `${lease.head} had no verdict to carry`, clean: true }
    assertHeld(this.parts.db, lease)
    try {
      this.parts.publish({ commit: to, state: STATE_OF_VERDICT[before.verdict], context: REVIEW_STATUS_CONTEXT, description: `carried from ${lease.head} by a clean update-branch` })
    }
    catch (error) {
      this.executed(lease, 'publish', { ok: false, error: messageOf(error) })
      return { carried: null, why: messageOf(error), clean: true }
    }
    this.executed(lease, 'publish', { ok: true })
    return { carried: before.verdict, rules_version: this.carriedRulesVersion(lease, before.verdict), clean: true }
  }

  private carriedRulesVersion(lease: Lease, verdict: VerdictOnHead): number | null {
    const recorded = recordedVerdictOn(this.parts.db, lease.pr!, lease.head!)
    return recorded?.verdict === verdict ? recorded.rulesVersion : null
  }

  private updated(lease: Lease, before: Before): UpdateOutcome {
    const to = this.newHead(lease)
    return this.done(lease, to, this.carry(lease, before, to))
  }

  private conflicting(lease: Lease, card: CardFields | null): UpdateOutcome {
    if (card === null)
      return this.denied(lease, technical(MERGE_REFUSED, `card #${lease.cardId} has no admitted body, so its branch and touches are unknown`))
    this.allowed(lease, MERGE_MAIN_COMMAND)
    const merge = this.parts.mergeMain!(conflictingCardOf((cardId, files) => pathsOutsideTheBody(this.parts.db, cardId, files.join('\n')), lease.cardId, card.branch, lease.head!))
    this.executed(lease, MERGE_MAIN_COMMAND, merge.kind === 'merged' ? { ok: true } : { ok: false, error: merge.kind === 'refused' ? merge.why : `conflicts inside the card's touches: ${merge.files.join(', ')}` })
    if (merge.kind === 'refused')
      return this.denied(lease, technical(MERGE_REFUSED, merge.why))
    if (merge.kind === 'inside')
      return this.denied(lease, technical(MERGE_REFUSED, insideTheTouchesLine(lease, merge.files)))
    const why = merge.tookMain.length === 0 ? `a merge of ${MAIN_BRANCH} into the card tree` : `a merge of ${MAIN_BRANCH} into the card tree that took ${MAIN_BRANCH} on ${merge.tookMain.join(', ')}`
    const carry: Carry = { carried: null, why, clean: false }
    const event: BusEvent = { ts: this.ts(), type: UPDATE_DONE, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${UPDATE_DONE}:${lease.taskKey}`, payload: { from: lease.head, to: merge.to, ...carry, tookMain: merge.tookMain, rebuilt: merge.rebuilt, task_key: lease.taskKey, lease_gen: lease.leaseGen }, legacy: false }
    completeTask(this.parts.db, this.parts.cards, this.ts(), lease, [event])
    return { kind: 'updated', taskKey: lease.taskKey, from: lease.head!, to: merge.to, carry }
  }

  private allowed(lease: Lease, command: UpdateCommand = UPDATE_COMMAND): void {
    appendEvent(this.parts.db, { ts: this.ts(), type: POLICY_ALLOWED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_ALLOWED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command, task_key: lease.taskKey, lease_gen: lease.leaseGen }, legacy: false })
  }

  private executed(lease: Lease, command: UpdateCommand, result: CommandResult): void {
    appendEvent(this.parts.db, { ts: this.ts(), type: COMMAND_EXECUTED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${COMMAND_EXECUTED}:${lease.taskKey}:${lease.leaseGen}:${command}`, payload: { command, task_key: lease.taskKey, lease_gen: lease.leaseGen, ...result }, legacy: false })
  }

  private denied(lease: Lease, denial: UpdateDenial): UpdateOutcome {
    const ts = this.ts()
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: UPDATE_COMMAND, ...denial }, legacy: false }
    if (denial.reason === 'not_behind') {
      completeTask(this.parts.db, this.parts.cards, ts, lease, [event])
      return { kind: 'denied', taskKey: lease.taskKey, denial, next: COMPLETED }
    }
    if (WAIT_REASONS.has(denial.reason)) {
      releaseTask(this.parts.db, this.parts.cards, ts, lease, denial.reason, [event])
      return { kind: 'denied', taskKey: lease.taskKey, denial, next: 'queued' }
    }
    const next = failTask(this.parts.db, this.parts.cards, ts, lease, { reason: denial.reason, withdraw: WITHDRAWN_REASONS.has(denial.reason) }, this.parts.silentMs, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}

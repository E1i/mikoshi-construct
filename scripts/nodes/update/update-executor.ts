import type { DatabaseSync } from 'node:sqlite'
import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { RerunMode } from '../../cli/check-catalog.js'
import type { BusEvent } from '../../core/db.js'
import type { AfterFailure, Lease } from '../../core/lease.js'
import type { CardFields } from '../../intake/card-contract.js'
import type { ReviewStatus, StatusPublisher } from '../../ports/github-status.js'
import type { CommandResult, GitHub, GitHubPut } from '../../ports/github.js'
import type { VerdictOnHead } from '../../ports/snapshot.js'
import type { TechnicalReason } from '../review/record-verdict.js'
import { spawnSync } from 'node:child_process'
import { rerunOf, upToDateRequired } from '../../cli/check-catalog.js'
import { pathsOutsideTheBody } from '../../core/card-bodies.js'
import { appendEvent, openBusWait } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { CARD_STOPPED, CI_RERUN_REQUESTED, COMMAND_EXECUTED, POLICY_ALLOWED, POLICY_DENIED, QUESTION_OWNER, REVIEW_RECORDED, UPDATE_DONE } from '../../core/events.js'
import { commandLine, isRebuiltOnUpdate, rebuildsOf, SHARED_APPEND_PATHS } from '../../core/generated-files.js'
import { assertHeld, completeTask, failTask, releaseTask, StaleLease } from '../../core/lease.js'
import { rerunDueOn } from '../../core/observations.js'
import { KEPT_BY_PUSH_POLICY } from '../../core/push-policy.js'
import { COMPLETED, MERGE_REFUSED, updateTurnHeldFrom } from '../../core/queue.js'
import { cardContract, NOT_MINE, notMine } from '../../intake/card-contract.js'
import { cardDecisionCommand } from '../../policy/shards.js'
import { rerunFailedJobsEndpoint, runsOnHeadEndpoint } from '../../ports/ci-reading.js'
import { REVIEW_STATUS_CONTEXT } from '../../ports/github-status.js'
import { Meter } from '../../ports/meter.js'
import { CANCELLED, MAIN_BRANCH, MERGEABLE_OF_STATE, verdictOf } from '../../ports/snapshot.js'
import { pollHead } from './head-poll.js'

export const UPDATED_STATUS = 202
export const STALE_HEAD_ON_UPDATE = 422
export const HEAD_READS = 5
export const RERUN_ACCEPTED = 201
const RERUN_CONCLUSIONS: ReadonlySet<unknown> = new Set([CANCELLED, 'failure', 'timed_out'])
const FILES_PAGE = 100
const REPO = 'repos/{owner}/{repo}'
const STATE_OF_VERDICT: Record<VerdictOnHead, ReviewStatus['state']> = { pass: 'success', changes: 'failure' }

export const MERGES_WITHOUT_UPDATE = 'merges_without_update'
export const WAITS_ITS_TURN = 'waits_its_turn'
const UPDATE_COMMAND = 'update_branch'
const MERGE_MAIN_COMMAND = 'merge_main'
const MAIN_REF = `origin/${MAIN_BRANCH}`

export type UpdateCommand = typeof UPDATE_COMMAND | typeof MERGE_MAIN_COMMAND | 'publish'

export type UpdateTechnicalReason = TechnicalReason | 'not_mergeable' | 'not_behind' | 'wrong_base' | typeof MERGE_REFUSED | typeof NOT_MINE | typeof MERGES_WITHOUT_UPDATE | typeof WAITS_ITS_TURN | typeof KEPT_BY_PUSH_POLICY

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

export interface ConflictingCard {
  cardId: number
  branch: string
  outsideTheCard: (files: string[]) => string[]
  head: string
}

export type MainMerge
  = | { kind: 'merged', to: string, tookMain: string[], rebuilt: string[] }
    | { kind: 'inside', files: string[] }
    | { kind: 'refused', why: string }

export type MergeMain = (card: ConflictingCard) => MainMerge

export type TreeGit = (cwd: string, args: string[]) => string

export interface UpdateParts {
  db: DatabaseSync
  gitHub: GitHub
  put: GitHubPut
  publish: StatusPublisher
  clock: () => Date
  settle: () => void
  rerun?: RerunMode
  pushPolicy?: () => PushPolicy
  mergeMain?: MergeMain
  post?: GitHubPut
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

const VERDICT_RECORDS_OF_A_HEAD = `SELECT type, payload FROM events WHERE legacy = 0 AND pr = ? AND ((type = '${REVIEW_RECORDED}' AND head = ?) OR (type = '${UPDATE_DONE}' AND json_extract(payload, '$.to') = ? AND json_extract(payload, '$.carried') IS NOT NULL)) ORDER BY id DESC LIMIT 1`

export function recordedVerdictOn(db: DatabaseSync, pr: number, head: string): RecordedVerdict | null {
  const row = db.prepare(VERDICT_RECORDS_OF_A_HEAD).get(pr, head, head) as { type: string, payload: string } | undefined
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

const WAIT_REASONS: ReadonlySet<UpdateTechnicalReason> = new Set(['not_mergeable', MERGES_WITHOUT_UPDATE, WAITS_ITS_TURN])
const WITHDRAWN_REASONS: ReadonlySet<UpdateTechnicalReason> = new Set([NOT_MINE, KEPT_BY_PUSH_POLICY, MERGE_REFUSED])

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

function unmergedIn(git: TreeGit, tree: string): string[] {
  return git(tree, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(file => file !== '')
}

function onMain(git: TreeGit, tree: string, file: string): boolean {
  try {
    git(tree, ['cat-file', '-e', `${MAIN_REF}:${file}`])
    return true
  }
  catch {
    return false
  }
}

function takeMain(git: TreeGit, tree: string, file: string): void {
  if (onMain(git, tree, file))
    git(tree, ['checkout', MAIN_REF, '--', file])
  else
    git(tree, ['rm', '-q', '--', file])
}

function abortMerge(git: TreeGit, tree: string): void {
  try {
    git(tree, ['merge', '--abort'])
  }
  catch {}
}

export type RebuildRunner = (cwd: string, args: readonly string[]) => { status: number | null, stderr: string }

function pnpmRebuild(cwd: string, args: readonly string[]): { status: number | null, stderr: string } {
  const result = spawnSync('pnpm', [...args], { cwd, encoding: 'utf8' })
  return { status: result.status, stderr: result.error?.message ?? result.stderr }
}

function rebuildGenerated(git: TreeGit, tree: string, card: ConflictingCard, files: readonly string[], run: RebuildRunner): MainMerge | null {
  for (const rebuild of rebuildsOf(files)) {
    const result = run(tree, rebuild)
    if (result.status !== 0) {
      git(tree, ['reset', '-q', '--hard', card.head])
      return { kind: 'refused', why: `the rebuild after the merge of ${MAIN_BRANCH} failed, and the tree went back to ${card.head}: ${commandLine(rebuild)} exited ${result.status ?? 'without a status'}: ${result.stderr.trim()}` }
    }
  }
  const changed = git(tree, ['ls-files', '-m', '-o', '--exclude-standard', '--', ...SHARED_APPEND_PATHS]).split('\n').filter(file => file !== '')
  if (changed.length > 0) {
    git(tree, ['add', '--', ...changed])
    git(tree, ['commit', '-q', '--amend', '--no-edit'])
  }
  return null
}

export function conflictingCardOf(db: DatabaseSync, cardId: number, branch: string, head: string): ConflictingCard {
  return { cardId, branch, outsideTheCard: files => pathsOutsideTheBody(db, cardId, files.join('\n')), head }
}

export type MergedMain = 'pushed' | 'kept-in-the-tree'

function mergeMainIn(git: TreeGit, tree: string, card: ConflictingCard, run: RebuildRunner, merged: MergedMain): MainMerge {
  const at = git(tree, ['rev-parse', 'HEAD'])
  if (at !== card.head)
    return { kind: 'refused', why: `the tree ${tree} stands at ${at}, not at the head ${card.head}` }
  if (git(tree, ['status', '--porcelain']) !== '')
    return { kind: 'refused', why: `the tree ${tree} has changes of its own` }
  git(tree, ['fetch', '-q', 'origin', MAIN_BRANCH])
  const carried = git(tree, ['diff', '--name-only', `${MAIN_REF}...HEAD`]).split('\n').filter(isRebuiltOnUpdate)
  let tookMain: string[] = []
  let conflicted: string[] = []
  try {
    git(tree, ['merge', '-q', '--no-edit', MAIN_REF])
  }
  catch (error) {
    const files = unmergedIn(git, tree)
    if (files.length === 0) {
      abortMerge(git, tree)
      return { kind: 'refused', why: messageOf(error) }
    }
    conflicted = files.filter(isRebuiltOnUpdate)
    const rest = files.filter(file => !isRebuiltOnUpdate(file))
    const outside = card.outsideTheCard(rest)
    const inside = rest.filter(file => !outside.includes(file))
    if (inside.length > 0) {
      abortMerge(git, tree)
      return { kind: 'inside', files: inside }
    }
    for (const file of files)
      takeMain(git, tree, file)
    git(tree, ['commit', '-q', '--no-edit'])
    tookMain = rest
  }
  const moved = git(tree, ['rev-parse', 'HEAD']) !== card.head
  const rebuilt = moved ? [...new Set([...conflicted, ...carried])] : []
  const refused = rebuildGenerated(git, tree, card, rebuilt, run)
  if (refused !== null)
    return refused
  return merged === 'pushed' ? pushedOrUndone(git, tree, card, tookMain, rebuilt) : { kind: 'merged', to: git(tree, ['rev-parse', 'HEAD']), tookMain, rebuilt }
}

function pushedOrUndone(git: TreeGit, tree: string, card: ConflictingCard, tookMain: string[], rebuilt: string[]): MainMerge {
  const to = git(tree, ['rev-parse', 'HEAD'])
  try {
    git(tree, ['push', '-q', 'origin', `HEAD:refs/heads/${card.branch}`])
  }
  catch (error) {
    git(tree, ['reset', '-q', '--hard', card.head])
    return { kind: 'refused', why: `the push of the merge ${to} to ${card.branch} failed, and the tree went back to ${card.head}: ${messageOf(error)}` }
  }
  return { kind: 'merged', to, tookMain, rebuilt }
}

export function mainMergeInCardTree(git: TreeGit, treeOf: (cardId: number) => string, run: RebuildRunner = pnpmRebuild, merged: MergedMain = 'pushed'): MergeMain {
  return (card) => {
    const tree = treeOf(card.cardId)
    try {
      return mergeMainIn(git, tree, card, run, merged)
    }
    catch (error) {
      abortMerge(git, tree)
      return { kind: 'refused', why: messageOf(error) }
    }
  }
}

function treeGit(cwd: string, args: string[]): string {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (run.error !== undefined || run.status !== 0)
    throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${run.error?.message ?? run.stderr.trim()}`)
  return run.stdout.trim()
}

export function mainKeptInTheTree(tree: string): MergeMain {
  return mainMergeInCardTree(treeGit, () => tree, pnpmRebuild, 'kept-in-the-tree')
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
      const rerun = this.rerunWhenDue(lease)
      if (rerun !== null)
        return rerun
      const checked = this.fresh(lease)
      if (checked.kind === 'denied')
        return this.denied(lease, checked.denial)
      if (checked.kind === 'conflicting')
        return this.conflicting(lease, card)
      if (updateTurnHeldFrom(this.parts.db, this.ts(), lease.pr!))
        return this.denied(lease, technical(WAITS_ITS_TURN, `#${lease.pr} waits: an updated pull request is still on its way to merging`))
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

  private rerunDue(lease: Lease): boolean {
    return lease.pr !== null && lease.head !== null && rerunDueOn(this.parts.db, lease.pr, lease.head)
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
    completeTask(this.parts.db, this.ts(), lease, [event])
    return { kind: 'rerun', taskKey: lease.taskKey, requested: request.requested, detail: request.detail }
  }

  private conflictingAt(lease: Lease): boolean {
    return this.parts.db.prepare(`SELECT 1 FROM prs WHERE pr = ? AND head = ? AND mergeable = 'dirty'`).get(lease.pr, lease.head) !== undefined
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
      const refused = this.parts.rerun === 'by-layers' ? this.byLayers(meter, pull, lease, mergeable) : this.notBehind(lease, mergeable)
      if (refused !== null)
        return { kind: 'denied', denial: refused }
      return { kind: 'ready', before: { verdict: verdictOf(meter, lease.head!), files: diffOf(meter, lease.pr!) } }
    }
    catch (error) {
      return { kind: 'denied', denial: technical('github_error', messageOf(error)) }
    }
  }

  private notBehind(lease: Lease, mergeable: string): UpdateDenial | null {
    return mergeable === 'behind' ? null : technical('not_behind', `#${lease.pr} is ${mergeable}, not behind`)
  }

  private byLayers(meter: Meter, pull: Pull, lease: Lease, mergeable: string): UpdateDenial | null {
    if (mergeable !== 'clean')
      return this.notBehind(lease, mergeable) ?? this.mergesWithoutUpdate(meter, pull, lease)
    if (upToDateRequired(meter))
      return technical('not_behind', `#${lease.pr} is clean on a host that requires an up-to-date branch, not behind`)
    const rerun = rerunOf(this.parts.db, meter, lease.pr!, pull.base?.sha, lease.head!)
    return rerun.rerun ? null : technical('not_behind', `#${lease.pr} is clean and needs no update: ${rerun.why}`)
  }

  private mergesWithoutUpdate(meter: Meter, pull: Pull, lease: Lease): UpdateDenial | null {
    const rerun = rerunOf(this.parts.db, meter, lease.pr!, pull.base?.sha, lease.head!)
    return rerun.rerun ? null : technical(MERGES_WITHOUT_UPDATE, `#${lease.pr} merges without an update: ${rerun.why}`)
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
    const carry = this.carry(lease, before, to)
    const event: BusEvent = { ts: this.ts(), type: UPDATE_DONE, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${UPDATE_DONE}:${lease.taskKey}`, payload: { from: lease.head, to, ...carry, task_key: lease.taskKey, lease_gen: lease.leaseGen }, legacy: false }
    completeTask(this.parts.db, this.ts(), lease, [event])
    return { kind: 'updated', taskKey: lease.taskKey, from: lease.head!, to, carry }
  }

  private conflicting(lease: Lease, card: CardFields | null): UpdateOutcome {
    if (card === null)
      return this.denied(lease, technical(MERGE_REFUSED, `card #${lease.cardId} has no admitted body, so its branch and touches are unknown`))
    this.allowed(lease, MERGE_MAIN_COMMAND)
    const merge = this.parts.mergeMain!(conflictingCardOf(this.parts.db, lease.cardId, card.branch, lease.head!))
    this.executed(lease, MERGE_MAIN_COMMAND, merge.kind === 'merged' ? { ok: true } : { ok: false, error: merge.kind === 'refused' ? merge.why : `conflicts inside the card's touches: ${merge.files.join(', ')}` })
    if (merge.kind === 'refused')
      return this.denied(lease, technical(MERGE_REFUSED, merge.why))
    if (merge.kind === 'inside')
      return this.ownersStop(lease, `pull request #${lease.pr} conflicts with ${MAIN_BRANCH} at ${lease.head} inside the card's own touches: ${merge.files.join(', ')}`)
    const why = merge.tookMain.length === 0 ? `a merge of ${MAIN_BRANCH} into the card tree` : `a merge of ${MAIN_BRANCH} into the card tree that took ${MAIN_BRANCH} on ${merge.tookMain.join(', ')}`
    const carry: Carry = { carried: null, why, clean: false }
    const event: BusEvent = { ts: this.ts(), type: UPDATE_DONE, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${UPDATE_DONE}:${lease.taskKey}`, payload: { from: lease.head, to: merge.to, ...carry, tookMain: merge.tookMain, rebuilt: merge.rebuilt, task_key: lease.taskKey, lease_gen: lease.leaseGen }, legacy: false }
    completeTask(this.parts.db, this.ts(), lease, [event])
    return { kind: 'updated', taskKey: lease.taskKey, from: lease.head!, to: merge.to, carry }
  }

  private ownersStop(lease: Lease, detail: string): UpdateOutcome {
    const ask = { need: 'decision' as const, text: `card #${lease.cardId} asks: ${detail}`, command: cardDecisionCommand(lease.cardId), card: lease.cardId, ...(lease.pr === null ? {} : { pr: lease.pr }) }
    const stop: BusEvent = { ts: this.ts(), type: CARD_STOPPED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${CARD_STOPPED}:${lease.taskKey}:${lease.leaseGen}`, payload: { reason: QUESTION_OWNER, detail }, legacy: false }
    completeTask(this.parts.db, this.ts(), lease, [stop], db => openBusWait(db, this.ts(), lease.actor, ask))
    return { kind: 'stopped', taskKey: lease.taskKey, reason: QUESTION_OWNER, detail }
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
      completeTask(this.parts.db, ts, lease, [event])
      return { kind: 'denied', taskKey: lease.taskKey, denial, next: COMPLETED }
    }
    if (WAIT_REASONS.has(denial.reason)) {
      releaseTask(this.parts.db, ts, lease, denial.reason, [event])
      return { kind: 'denied', taskKey: lease.taskKey, denial, next: 'queued' }
    }
    const next = failTask(this.parts.db, ts, lease, { reason: denial.reason, withdraw: WITHDRAWN_REASONS.has(denial.reason) }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}

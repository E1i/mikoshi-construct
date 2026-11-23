import type { DatabaseSync } from 'node:sqlite'
import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { BusEvent } from '../../core/db.js'
import type { AfterFailure, CardTransitions, Lease } from '../../core/lease.js'
import type { CandidateRules } from '../../core/queue.js'
import type { AllowedRule, AuthorityRule, MergeFacts, PatchedFile } from '../../policy/policy.js'
import type { CompositionRecord } from '../../policy/touch-scope.js'
import type { StatusPublisher } from '../../ports/github-status.js'
import type { CommandResult, GitHub, GitHubPut } from '../../ports/github.js'
import type { TechnicalReason } from '../review/record-verdict.js'
import { Buffer } from 'node:buffer'
import { changedFiles, changedPaths, mainFilesSince, REFUSED_NOT_UP_TO_DATE } from '../../cli/check-catalog.js'
import { loadCompositionModels } from '../../composition/files.js'
import { NOT_MINE, notMine } from '../../core/card-automaton.js'
import { cardHoldOf, HOLD_RECHECK_MS } from '../../core/card-hold.js'
import { closedWaitIds } from '../../core/card-readings.js'
import { appendEvent, openBusWait } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { BOARD_ALARM, COMMAND_EXECUTED, MERGE_DONE, POLICY_ALLOWED, POLICY_DENIED, SHARD_USED } from '../../core/events.js'
import { isFullSha } from '../../core/identifiers.js'
import { assertHeld, completeTask, failTask, releaseTask, StaleLease, waitTask } from '../../core/lease.js'
import { KEPT_BY_PUSH_POLICY } from '../../core/push-policy.js'
import { keyOf, NEEDS_UPDATE, openDecisionWaitsOfCard, QUESTION_OPEN, QUEUE_ACTOR, reviewsInFlightOn, widenedOnTheAdmission } from '../../core/queue.js'
import { cardContract } from '../../intake/card-contract.js'
import { allowLiveCommand, liveDecisionOf } from '../../policy/live-decision.js'
import { mergePolicy, OWNER_MERGES, OWNER_MERGES_RULES, underOwnerDecision, VERSION_BRANCH, WITNESS_REASON, witnessDenial, witnessSubjectOf } from '../../policy/policy.js'
import { activeWindowShards, decisionsInForceAt, expiredWindowShards, shardActive, unspentShard } from '../../policy/shards.js'
import { followsTouches, pathsOutside, removesEntriesOnly, textBeforePatch } from '../../policy/touch-scope.js'
import { ciOf, GitHubCommitCi } from '../../ports/ci-reading.js'
import { REVIEW_STATUS_CONTEXT } from '../../ports/github-status.js'
import { Meter, RateLimited, retryAfterSeconds } from '../../ports/meter.js'
import { MAIN_BRANCH, MERGEABLE_OF_STATE, OPEN_PULLS_PAGE, verdictOf } from '../../ports/snapshot.js'
import { mergeCandidates } from './merge-candidates.js'

export const MERGE_METHOD = 'squash'
export const MERGE_QUEUE = 'merge'
export const STALE_HEAD_STATUS = 409
export const NOT_ALLOWED_STATUS = 405
const RATE_LIMITED_STATUS = 429
const NOT_UP_TO_DATE = /not up.to.date/i
export const HELD_FOR_OWNER = 'held_for_owner'
export const HEAD_OUTSIDE_TOUCHES = 'outside_touches'
const WAIT_REASONS: ReadonlySet<MergeTechnicalReason> = new Set(['version_pr_open', 'not_mergeable', 'not_a_candidate', HELD_FOR_OWNER, HEAD_OUTSIDE_TOUCHES])

export type MainOverlap = (pr: readonly string[], main: readonly string[]) => boolean
const WITHDRAWN_ON_THE_BODY: ReadonlySet<AuthorityRule> = new Set(['decision_unread', 'no_matrix_count_line'])
const FILES_PAGE = 100
const REPO = 'repos/{owner}/{repo}'

export type MergeTechnicalReason = TechnicalReason | 'not_mergeable' | 'no_pass_on_head' | 'version_pr_open' | 'wrong_base' | 'not_a_candidate' | 'not_mine' | typeof HELD_FOR_OWNER | typeof HEAD_OUTSIDE_TOUCHES | typeof QUESTION_OPEN | typeof WITNESS_REASON | typeof NEEDS_UPDATE | typeof KEPT_BY_PUSH_POLICY

export type ParkedUntil = 'new_head' | 'wait_closed'

export type MergeDenial
  = | { kind: 'technical', reason: MergeTechnicalReason, detail: string, base?: string, parkedUntil?: ParkedUntil, refusal?: typeof REFUSED_NOT_UP_TO_DATE }
    | { kind: 'authority', rule: AuthorityRule, detail: string }

export type MergeCommand = 'merge' | 'publish'

export type MergeOutcome
  = | { kind: 'merged', taskKey: string, commit: string, rule: AllowedRule }
    | { kind: 'denied', taskKey: string, denial: MergeDenial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export interface ExecutorParts {
  db: DatabaseSync
  cards: CardTransitions
  gitHub: GitHub
  put: GitHubPut
  publish: StatusPublisher
  clock: () => Date
  run: string | null
  silentMs: number
  pushPolicy?: () => PushPolicy
  overlaps: MainOverlap
  rules: CandidateRules
  requiredCheck: () => string
}

interface Pull {
  number?: number
  state?: string
  merged?: boolean
  merge_commit_sha?: string | null
  base?: { ref?: string, sha?: string }
  title?: string
  body?: string | null
  mergeable_state?: string
  head?: { sha?: string, ref?: string }
}

type AddedFile = PatchedFile & { status?: string }
type Checked = { kind: 'ready', facts: MergeFacts, mergedCommit: string | null, base: string | null, shard: string | null, decidedPastRoundLimit: number | null } | { kind: 'denied', denial: MergeDenial }

function technical(reason: MergeTechnicalReason, detail: string): Checked {
  return { kind: 'denied', denial: { kind: 'technical', reason, detail } }
}

function ownerMergesText(meter: Meter): string {
  const file = meter.get(`${REPO}/contents/${OWNER_MERGES}?ref=${MAIN_BRANCH}`) as { content?: string }
  if (typeof file.content !== 'string')
    throw new Error(`${OWNER_MERGES} on ${MAIN_BRANCH} came back with no content`)
  return Buffer.from(file.content, 'base64').toString('utf8')
}

function patchedFiles(meter: Meter, pr: number): PatchedFile[] {
  const files: PatchedFile[] = []
  for (let page = 1; ; page += 1) {
    const listed = meter.get(`${REPO}/pulls/${pr}/files?per_page=${FILES_PAGE}&page=${page}`) as PatchedFile[]
    files.push(...listed)
    if (listed.length < FILES_PAGE)
      return files
  }
}

function contentAt(meter: Meter, file: string, ref: string): string | null {
  try {
    const read = meter.get(`${REPO}/contents/${file}?ref=${ref}`) as { content?: string }
    return typeof read.content === 'string' ? Buffer.from(read.content, 'base64').toString('utf8') : null
  }
  catch {
    return null
  }
}

function entriesOnlyRemovedByThePatch(meter: Meter, patched: readonly PatchedFile[], head: string): (file: string) => boolean {
  return (file) => {
    const patch = patched.find(changed => changed.filename === file)?.patch
    if (patch === undefined)
      return false
    const after = contentAt(meter, file, head)
    return after !== null && removesEntriesOnly(textBeforePatch(after, patch), after)
  }
}

function compositionRecordsOfTheCheckout(): CompositionRecord[] {
  try {
    return loadCompositionModels().map(loaded => loaded.model)
  }
  catch {
    return []
  }
}

function textOf(body: unknown): string {
  if (typeof body === 'string')
    return body
  const message = (body as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : JSON.stringify(body)
}

export class MergeExecutor {
  constructor(private readonly parts: ExecutorParts) {}

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  merge(lease: Lease): MergeOutcome {
    try {
      assertHeld(this.parts.db, lease)
      if (this.parts.pushPolicy?.() === 'none')
        return this.denied(lease, { kind: 'technical', reason: KEPT_BY_PUSH_POLICY, detail: `push policy none: the bus does not merge #${lease.pr}` })
      const foreign = notMine(cardContract(this.parts.db, lease.cardId), 'merge')
      if (foreign !== null)
        return this.denied(lease, { kind: 'technical', reason: NOT_MINE, detail: foreign })
      this.askForAllowLive()
      for (const expired of expiredWindowShards(this.parts.db, this.parts.clock(), lease.actor))
        appendEvent(this.parts.db, expired)
      const checked = this.fresh(lease)
      if (checked.kind === 'denied')
        return this.denied(lease, this.heldInsteadOfAWait(lease, checked.denial))
      const hold = checked.mergedCommit === null ? cardHoldOf(this.parts.db, lease.cardId) : null
      if (hold !== null)
        return this.denied(lease, { kind: 'technical', reason: HELD_FOR_OWNER, detail: hold })
      const asked = checked.mergedCommit === null ? this.heldByAnOpenQuestion(lease) : null
      if (asked !== null)
        return this.denied(lease, asked)
      const outside = checked.mergedCommit === null ? this.outsideTouches(lease, checked.facts.patched) : null
      if (outside !== null)
        return this.denied(lease, outside)
      const gated = checked.mergedCommit === null && witnessSubjectOf(this.parts.db, lease.cardId) !== null
      const unwitnessed = gated ? witnessDenial(this.parts.db, lease.cardId, lease.head, checked.base) : null
      if (unwitnessed !== null)
        return this.denied(lease, { kind: 'technical', reason: WITNESS_REASON, detail: unwitnessed.detail, ...(unwitnessed.base === null ? {} : { base: unwitnessed.base }) })
      const witnessBase = gated ? checked.base : null
      const overlapping = checked.mergedCommit === null ? this.checkBeforeMerge(lease, checked.base) : null
      if (overlapping !== null)
        return this.denied(lease, overlapping)
      const withdrawn = checked.mergedCommit === null ? this.noLongerACandidate(lease) : null
      if (withdrawn !== null)
        return this.denied(lease, withdrawn)
      const policy = mergePolicy(checked.facts)
      const decision = checked.decidedPastRoundLimit
      const verdict = decision === null ? policy : underOwnerDecision(policy, decision, lease.pr!, lease.head!)
      if (verdict.kind === 'denied')
        return this.denied(lease, { kind: 'authority', rule: verdict.rule, detail: verdict.detail })
      const spent = policy.rule === 'owner_under_shard' ? checked.shard : null
      if (checked.mergedCommit !== null) {
        this.allowed(lease, verdict.rule)
        return this.finished(lease, checked.mergedCommit, verdict.rule, spent)
      }
      const locked = this.versionLock(lease)
      if (locked !== null)
        return this.denied(lease, locked)
      this.allowed(lease, verdict.rule)
      if (decision !== null) {
        const unready = this.reviewStatusOfTheDecision(lease, decision) ?? this.cleanAfterTheStatus(lease)
        if (unready !== null)
          return this.denied(lease, unready)
      }
      return this.merged(lease, verdict.rule, spent, witnessBase)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private askForAllowLive(): void {
    if (liveDecisionOf(decisionsInForceAt(this.parts.db, this.parts.clock()), MERGE_QUEUE) !== null || this.underTheOwnersWindowShard())
      return
    openBusWait(this.parts.db, closedWaitIds(this.parts.db), this.ts(), QUEUE_ACTOR, { need: 'command', text: `the ${MERGE_QUEUE} queue merges with no owner decision in force naming it live`, command: allowLiveCommand(MERGE_QUEUE) })
  }

  private underTheOwnersWindowShard(): boolean {
    return activeWindowShards(this.parts.db, this.parts.clock()).some(shard => shard.scope === MERGE_QUEUE)
  }

  private askTheOwnerToMerge(lease: Lease, denial: MergeDenial): void {
    if (denial.kind !== 'authority' || !OWNER_MERGES_RULES.has(denial.rule) || lease.pr === null)
      return
    openBusWait(this.parts.db, closedWaitIds(this.parts.db), this.ts(), QUEUE_ACTOR, { need: 'merge', text: denial.detail, card: lease.cardId, pr: lease.pr })
  }

  private heldInsteadOfAWait(lease: Lease, denial: MergeDenial): MergeDenial {
    if (denial.kind !== 'technical' || !WAIT_REASONS.has(denial.reason) || denial.parkedUntil !== undefined)
      return denial
    const hold = cardHoldOf(this.parts.db, lease.cardId)
    return hold === null ? denial : { kind: 'technical', reason: HELD_FOR_OWNER, detail: hold }
  }

  private heldByAnOpenQuestion(lease: Lease): MergeDenial | null {
    const open = openDecisionWaitsOfCard(this.parts.db, lease.cardId)
    if (open.length === 0)
      return null
    const questions = open.map(wait => `${wait.id} (${wait.text})`).join(', ')
    return { kind: 'technical', reason: QUESTION_OPEN, detail: `card #${lease.cardId} waits for the owner's answer to ${questions}; #${lease.pr} merges once it is answered`, parkedUntil: 'wait_closed' }
  }

  private outsideTouches(lease: Lease, patched: readonly PatchedFile[]): MergeDenial | null {
    const card = cardContract(this.parts.db, lease.cardId)
    if (card === null)
      return null
    const widened = widenedOnTheAdmission(this.parts.db, lease.cardId, card.admissionEventId)
    const touches = [...card.touches, ...widened]
    const meter = new Meter(this.parts.gitHub, () => this.parts.clock().getTime())
    const reach = { touches, added: new Set(patched.filter(file => (file as AddedFile).status === 'added').map(file => file.filename)), compositionRecords: compositionRecordsOfTheCheckout(), entriesOnlyRemoved: entriesOnlyRemovedByThePatch(meter, patched, lease.head!) }
    const outside = pathsOutside(touches, card.creates, patched.map(file => file.filename)).filter(file => !followsTouches(file, reach))
    if (outside.length === 0)
      return null
    return { kind: 'technical', reason: HEAD_OUTSIDE_TOUCHES, detail: `#${lease.pr} changes ${outside.join(', ')}, outside the touches and creates card #${lease.cardId} was admitted with; it merges once an amend of the card covers them or the head drops them` }
  }

  private noLongerACandidate(lease: Lease): MergeDenial | null {
    if (mergeCandidates(this.parts.db, this.ts(), this.parts.rules).some(task => keyOf(task) === lease.taskKey))
      return null
    const reviews = reviewsInFlightOn(this.parts.db, lease.pr, lease.head)
    const holder = reviews.length === 0 ? 'no review in flight' : `the review ${reviews.join(', ')} in flight`
    return { kind: 'technical', reason: 'not_a_candidate', detail: `${lease.taskKey} is no longer a merge candidate: ${holder}` }
  }

  private fresh(lease: Lease): Checked {
    const meter = new Meter(this.parts.gitHub, () => this.parts.clock().getTime())
    try {
      const pull = meter.get(`${REPO}/pulls/${lease.pr}`) as Pull
      if (pull.base?.ref !== MAIN_BRANCH)
        return technical('wrong_base', `#${lease.pr} targets ${pull.base?.ref ?? 'no base'}, not ${MAIN_BRANCH}`)
      const mergedCommit = this.mergedAtLeasedHead(pull, lease)
      let decidedPastRoundLimit: number | null = null
      if (mergedCommit === null) {
        const moved = this.movedFromTheLease(pull, lease)
        if (moved !== null)
          return { kind: 'denied', denial: moved }
        const verdict = verdictOf(meter, lease.head!)
        if (verdict !== 'pass')
          decidedPastRoundLimit = this.parts.rules.mergeDecided(this.parts.db, this.ts(), lease.pr, lease.head)
        const unmergeable = decidedPastRoundLimit === null ? this.notClean(pull, lease) : null
        if (unmergeable !== null)
          return { kind: 'denied', denial: unmergeable }
        const ci = ciOf(meter, lease.head!, this.parts.requiredCheck())
        if (ci === 'red')
          return technical('ci_red', `CI is red on ${lease.head}`)
        if (ci !== 'green')
          return technical('ci_not_ready', `CI is ${ci} on ${lease.head}`)
        if (verdict === 'changes' && decidedPastRoundLimit === null)
          return { kind: 'denied', denial: { kind: 'technical', reason: 'no_pass_on_head', detail: `the review verdict on ${lease.head} turned changes; the answer to it brings a new head, and the merge waits for that head`, parkedUntil: 'new_head' } }
        if (verdict !== 'pass' && decidedPastRoundLimit === null)
          return technical('no_pass_on_head', `the review verdict on ${lease.head} is ${verdict ?? 'missing'}, not pass`)
      }
      const reportedBase = pull.base?.sha
      const baseSha = isFullSha(reportedBase) ? reportedBase : null
      const decisions = decisionsInForceAt(this.parts.db, this.parts.clock())
      const runShard = shardActive(this.parts.db, this.parts.run)
      const shard = runShard ? null : unspentShard(this.parts.db, lease.cardId, lease.pr, decisions)
      return {
        kind: 'ready',
        mergedCommit,
        base: baseSha,
        shard: shard?.id ?? null,
        decidedPastRoundLimit,
        facts: {
          cardId: lease.cardId,
          description: pull.body ?? '',
          headRef: pull.head?.ref ?? '',
          title: pull.title ?? '',
          files: changedFiles(meter, lease.pr!),
          patched: patchedFiles(meter, lease.pr!),
          ownerMergesText: ownerMergesText(meter),
          shardActive: runShard || shard !== null,
          shardUnder: shard?.under ?? null,
          windowShard: activeWindowShards(this.parts.db, this.parts.clock())[0]?.id ?? null,
          decisions,
        },
      }
    }
    catch (error) {
      return technical('github_error', messageOf(error))
    }
  }

  private reviewStatusOfTheDecision(lease: Lease, decision: number): MergeDenial | null {
    try {
      this.parts.publish({ commit: lease.head!, state: 'success', context: REVIEW_STATUS_CONTEXT, description: `owner decision D-${decision}, no review pass` })
    }
    catch (error) {
      this.executed(lease, 'publish', { ok: false, error: messageOf(error) })
      return { kind: 'technical', reason: 'github_error', detail: messageOf(error) }
    }
    this.executed(lease, 'publish', { ok: true })
    return null
  }

  private cleanAfterTheStatus(lease: Lease): MergeDenial | null {
    try {
      const pull = new Meter(this.parts.gitHub, () => this.parts.clock().getTime()).get(`${REPO}/pulls/${lease.pr}`) as Pull
      return this.movedFromTheLease(pull, lease) ?? this.notClean(pull, lease)
    }
    catch (error) {
      return { kind: 'technical', reason: 'github_error', detail: messageOf(error) }
    }
  }

  private movedFromTheLease(pull: Pull, lease: Lease): MergeDenial | null {
    if (pull.state === 'open' && pull.head?.sha === lease.head)
      return null
    return { kind: 'technical', reason: 'stale_head', detail: `#${lease.pr} is ${pull.state ?? 'unknown'} at ${pull.head?.sha ?? 'no head'}, the lease is for ${lease.head}` }
  }

  private checkBeforeMerge(lease: Lease, base: string | null): MergeDenial | null {
    const meter = new Meter(this.parts.gitHub, () => this.parts.clock().getTime())
    const main = base === null ? { kind: 'truncated' as const, why: `#${lease.pr} came back with no base sha` } : mainFilesSince(meter, base)
    const paths = main.kind === 'files' ? changedPaths(meter, lease.pr!) : []
    const shared = main.kind === 'files' ? main.files.filter(file => this.parts.overlaps(paths, [file])) : []
    if (main.kind === 'files' && shared.length === 0)
      return null
    const why = main.kind === 'truncated' ? `${main.why}, which counts as an overlap` : `${MAIN_BRANCH} changed ${shared.join(', ')} since ${base}, which overlaps #${lease.pr}`
    return { kind: 'technical', reason: NEEDS_UPDATE, detail: `the check before merge found what needsUpdate had not seen: ${why}; #${lease.pr} is updated once and gives the turn back`, parkedUntil: 'new_head' }
  }

  private notClean(pull: Pull, lease: Lease): MergeDenial | null {
    const mergeable = MERGEABLE_OF_STATE[pull.mergeable_state ?? '']
    if (mergeable === 'clean' || mergeable === 'behind')
      return null
    const detail = `#${lease.pr} is ${pull.mergeable_state ?? 'not computed yet'}, not clean`
    return { kind: 'technical', reason: 'not_mergeable', detail, ...(mergeable === 'dirty' ? { parkedUntil: 'new_head' as const } : {}) }
  }

  private mergedAtLeasedHead(pull: Pull, lease: Lease): string | null {
    if (pull.state === 'closed' && pull.merged === true && pull.head?.sha === lease.head && isFullSha(pull.merge_commit_sha))
      return pull.merge_commit_sha
    return null
  }

  private versionLock(lease: Lease): MergeDenial | null {
    try {
      const meter = new Meter(this.parts.gitHub, () => this.parts.clock().getTime())
      const ci = new GitHubCommitCi(meter)
      const open = meter.get(`${REPO}/pulls?state=open&per_page=${OPEN_PULLS_PAGE}`) as Pull[]
      const versionPr = open.find(candidate => candidate.number !== lease.pr && VERSION_BRANCH.test(candidate.head?.ref ?? '') && ci.approvedRunOn(candidate.head?.sha) && this.greenOn(ci, candidate.head?.sha))
      if (versionPr === undefined || this.cardNamesTheVersionPr(lease, versionPr.number))
        return null
      return { kind: 'technical', reason: 'version_pr_open', detail: `#${versionPr.number} is a version pull request with approved runs and green CI on ${versionPr.head?.sha} and locks every merge` }
    }
    catch (error) {
      return { kind: 'technical', reason: 'github_error', detail: messageOf(error) }
    }
  }

  private greenOn(ci: GitHubCommitCi, head: string | undefined): boolean {
    return head !== undefined && ci.onCommit(head, this.parts.requiredCheck()).state === 'green'
  }

  private cardNamesTheVersionPr(lease: Lease, versionPr: number | undefined): boolean {
    const text = cardContract(this.parts.db, lease.cardId)?.text
    return versionPr !== undefined && text !== undefined && new RegExp(`\\bPR #${versionPr}(?!\\d)`).test(text)
  }

  private finished(lease: Lease, commit: string, rule: AllowedRule, spent: string | null, witnessBase: string | null = null): MergeOutcome {
    completeTask(this.parts.db, this.parts.cards, this.ts(), lease, [this.done(lease, commit, rule, witnessBase), ...(spent === null ? [] : [this.used(lease, commit, spent)])])
    return { kind: 'merged', taskKey: lease.taskKey, commit, rule }
  }

  private merged(lease: Lease, rule: AllowedRule, spent: string | null, witnessBase: string | null): MergeOutcome {
    let response
    try {
      response = this.parts.put(`${REPO}/pulls/${lease.pr}/merge`, { sha: lease.head!, merge_method: MERGE_METHOD })
    }
    catch (error) {
      this.executed(lease, 'merge', { ok: false, error: messageOf(error) })
      return this.denied(lease, { kind: 'technical', reason: 'github_error', detail: messageOf(error) })
    }
    const commit = (response.body as { sha?: unknown } | null)?.sha
    const refusedWith = response.status === NOT_ALLOWED_STATUS ? textOf(response.body) : null
    this.executed(lease, 'merge', { ok: response.status === 200 && isFullSha(commit), status: response.status, ...(refusedWith === null ? {} : { text: refusedWith }) })
    if (refusedWith !== null && NOT_UP_TO_DATE.test(refusedWith))
      return this.denied(lease, { kind: 'technical', reason: NEEDS_UPDATE, refusal: REFUSED_NOT_UP_TO_DATE, detail: `GitHub answered ${response.status} to the merge of #${lease.pr}, so it is updated onto ${MAIN_BRANCH} first: ${refusedWith}`, parkedUntil: 'new_head' })
    if (refusedWith !== null)
      return this.denied(lease, { kind: 'technical', reason: 'github_error', detail: `GitHub answered ${response.status} to the merge of #${lease.pr}: ${refusedWith}` })
    if (response.status === RATE_LIMITED_STATUS)
      return this.denied(lease, { kind: 'technical', reason: 'github_error', detail: `${new RateLimited(response.status, retryAfterSeconds(response, this.parts.clock().getTime())).message} to the merge of #${lease.pr}` })
    if (response.status === STALE_HEAD_STATUS)
      return this.denied(lease, { kind: 'technical', reason: 'stale_head', detail: `GitHub answered ${response.status}: the head of #${lease.pr} is no longer ${lease.head}` })
    if (response.status !== 200 || !isFullSha(commit))
      return this.denied(lease, { kind: 'technical', reason: 'github_error', detail: `GitHub answered ${response.status} to the merge of #${lease.pr}` })
    return this.finished(lease, commit, rule, spent, witnessBase)
  }

  private done(lease: Lease, commit: string, rule: AllowedRule, witnessBase: string | null): BusEvent {
    return { ts: this.ts(), type: MERGE_DONE, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${MERGE_DONE}:${lease.taskKey}`, payload: { commit, rule, task_key: lease.taskKey, lease_gen: lease.leaseGen, ...(witnessBase === null ? {} : { witnessBase }) }, legacy: false }
  }

  private allowed(lease: Lease, rule: AllowedRule): void {
    appendEvent(this.parts.db, { ts: this.ts(), type: POLICY_ALLOWED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_ALLOWED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'merge', rule, task_key: lease.taskKey, lease_gen: lease.leaseGen }, legacy: false })
  }

  private executed(lease: Lease, command: MergeCommand, result: CommandResult & { text?: string }): void {
    appendEvent(this.parts.db, { ts: this.ts(), type: COMMAND_EXECUTED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${COMMAND_EXECUTED}:${lease.taskKey}:${lease.leaseGen}:${command}`, payload: { command, task_key: lease.taskKey, lease_gen: lease.leaseGen, ...result }, legacy: false })
  }

  private used(lease: Lease, commit: string, shard: string): BusEvent {
    return { ts: this.ts(), type: SHARD_USED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${SHARD_USED}:${shard}`, payload: { id: shard, commit }, legacy: false }
  }

  private denied(lease: Lease, denial: MergeDenial): MergeOutcome {
    const ts = this.ts()
    const reason = denial.kind === 'technical' ? denial.reason : denial.rule
    const parked = denial.kind === 'technical' && denial.parkedUntil !== undefined
    const waits = denial.kind === 'technical' && WAIT_REASONS.has(denial.reason)
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'merge', ...denial, ...(waits || parked ? {} : { refused: true }) }, legacy: false }
    if (parked)
      return { kind: 'denied', taskKey: lease.taskKey, denial, next: failTask(this.parts.db, this.parts.cards, ts, lease, { reason, withdraw: true }, this.parts.silentMs, [event]) }
    if (waits) {
      const until = reason === HELD_FOR_OWNER || reason === HEAD_OUTSIDE_TOUCHES ? new Date(this.parts.clock().getTime() + HOLD_RECHECK_MS).toISOString() : null
      if (until === null)
        releaseTask(this.parts.db, this.parts.cards, ts, lease, reason, [event])
      else
        waitTask(this.parts.db, this.parts.cards, ts, lease, { reason, until }, [event])
      return { kind: 'denied', taskKey: lease.taskKey, denial, next: 'queued' }
    }
    const next = failTask(this.parts.db, this.parts.cards, ts, lease, { reason, withdraw: denial.kind === 'authority' || reason === 'not_mine' || reason === WITNESS_REASON || reason === KEPT_BY_PUSH_POLICY }, this.parts.silentMs, [event])
    this.askTheOwnerToMerge(lease, denial)
    this.alarmOnTheBody(lease, denial)
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }

  private alarmOnTheBody(lease: Lease, denial: MergeDenial): void {
    if (denial.kind !== 'authority' || !WITHDRAWN_ON_THE_BODY.has(denial.rule))
      return
    appendEvent(this.parts.db, { ts: this.ts(), type: BOARD_ALARM, actor: QUEUE_ACTOR, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${BOARD_ALARM}:${lease.taskKey}`, payload: { task_key: lease.taskKey, reason: denial.rule, detail: denial.detail }, legacy: false })
  }
}

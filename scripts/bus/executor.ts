import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { GitHub, GitHubPut } from './github.js'
import type { AfterFailure, Lease } from './lease.js'
import type { AllowedRule, AuthorityRule, MergeFacts } from './policy.js'
import type { TechnicalReason } from './record-verdict.js'
import { Buffer } from 'node:buffer'
import { isFullSha } from './identifiers.js'
import { POLICY_DENIED } from './inbox.js'
import { assertHeld, completeTask, failTask, releaseTask, StaleLease } from './lease.js'
import { Meter } from './meter.js'
import { mergePolicy, VERSION_BRANCH } from './policy.js'
import { ciOf, MAIN_BRANCH, MERGEABLE_OF_STATE, OPEN_PULLS_PAGE, verdictOf } from './snapshot.js'

export const MERGE_DONE = 'merge.done'
export const SHARD_USED = 'shard.used'
export const OWNER_MERGES = 'architecture/owner-merges.md'
export const MERGE_METHOD = 'squash'
export const STALE_HEAD_STATUS = 409
const WAIT_REASONS: ReadonlySet<MergeTechnicalReason> = new Set(['version_pr_open', 'not_mergeable'])
const FILES_PAGE = 100
const RUNS_PAGE = 100
const AWAITING_APPROVAL = 'action_required'
const REPO = 'repos/{owner}/{repo}'

export type MergeTechnicalReason = TechnicalReason | 'not_mergeable' | 'no_pass_on_head' | 'version_pr_open' | 'wrong_base'

export type MergeDenial
  = | { kind: 'technical', reason: MergeTechnicalReason, detail: string }
    | { kind: 'authority', rule: AuthorityRule, detail: string }

export type MergeOutcome
  = | { kind: 'merged', taskKey: string, commit: string, rule: AllowedRule }
    | { kind: 'denied', taskKey: string, denial: MergeDenial, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

export interface ExecutorParts {
  db: DatabaseSync
  gitHub: GitHub
  put: GitHubPut
  clock: () => Date
  run: string | null
}

interface Pull {
  number?: number
  state?: string
  merged?: boolean
  merge_commit_sha?: string | null
  base?: { ref?: string }
  title?: string
  body?: string | null
  mergeable_state?: string
  head?: { sha?: string, ref?: string }
}

type Checked = { kind: 'ready', facts: MergeFacts, mergedCommit: string | null } | { kind: 'denied', denial: MergeDenial }

function technical(reason: MergeTechnicalReason, detail: string): Checked {
  return { kind: 'denied', denial: { kind: 'technical', reason, detail } }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function shardActive(db: DatabaseSync, run: string | null): boolean {
  if (run === null)
    return false
  return db.prepare(`SELECT 1 FROM events WHERE type = '${SHARD_USED}' AND json_extract(payload, '$.run') = ? LIMIT 1`).get(run) !== undefined
}

function changedFiles(meter: Meter, pr: number): string[] {
  const files: string[] = []
  for (let page = 1; ; page += 1) {
    const listed = meter.get(`${REPO}/pulls/${pr}/files?per_page=${FILES_PAGE}&page=${page}`) as { filename?: string }[]
    files.push(...listed.flatMap(file => file.filename === undefined ? [] : [file.filename]))
    if (listed.length < FILES_PAGE)
      return files
  }
}

function ownerMergesText(meter: Meter): string {
  const file = meter.get(`${REPO}/contents/${OWNER_MERGES}?ref=${MAIN_BRANCH}`) as { content?: string }
  if (typeof file.content !== 'string')
    throw new Error(`${OWNER_MERGES} on ${MAIN_BRANCH} came back with no content`)
  return Buffer.from(file.content, 'base64').toString('utf8')
}

function approvedRunsOn(meter: Meter, head: string | undefined): boolean {
  if (head === undefined)
    return false
  const runs = (meter.get(`${REPO}/actions/runs?head_sha=${head}&per_page=${RUNS_PAGE}`) as { workflow_runs?: { conclusion?: string | null }[] }).workflow_runs ?? []
  return runs.some(run => run.conclusion !== AWAITING_APPROVAL)
}

export class MergeExecutor {
  constructor(private readonly parts: ExecutorParts) {}

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  merge(lease: Lease): MergeOutcome {
    try {
      assertHeld(this.parts.db, lease)
      const checked = this.fresh(lease)
      if (checked.kind === 'denied')
        return this.denied(lease, checked.denial)
      const verdict = mergePolicy(checked.facts)
      if (verdict.kind === 'denied')
        return this.denied(lease, { kind: 'authority', rule: verdict.rule, detail: verdict.detail })
      if (checked.mergedCommit !== null)
        return this.finished(lease, checked.mergedCommit, verdict.rule)
      const locked = this.versionLock(lease)
      if (locked !== null)
        return this.denied(lease, locked)
      return this.merged(lease, verdict.rule)
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private fresh(lease: Lease): Checked {
    const meter = new Meter(this.parts.gitHub, () => this.parts.clock().getTime())
    try {
      const pull = meter.get(`${REPO}/pulls/${lease.pr}`) as Pull
      if (pull.base?.ref !== MAIN_BRANCH)
        return technical('wrong_base', `#${lease.pr} targets ${pull.base?.ref ?? 'no base'}, not ${MAIN_BRANCH}`)
      const mergedCommit = this.mergedAtLeasedHead(pull, lease)
      if (mergedCommit === null) {
        if (pull.state !== 'open' || pull.head?.sha !== lease.head)
          return technical('stale_head', `#${lease.pr} is ${pull.state ?? 'unknown'} at ${pull.head?.sha ?? 'no head'}, the lease is for ${lease.head}`)
        const mergeable = MERGEABLE_OF_STATE[pull.mergeable_state ?? '']
        if (mergeable !== 'clean')
          return technical('not_mergeable', `#${lease.pr} is ${pull.mergeable_state ?? 'not computed yet'}, not clean`)
        const ci = ciOf(meter, lease.head!)
        if (ci !== 'green')
          return technical('ci_not_ready', `CI is ${ci} on ${lease.head}`)
        const verdict = verdictOf(meter, lease.head!)
        if (verdict !== 'pass')
          return technical('no_pass_on_head', `the review verdict on ${lease.head} is ${verdict ?? 'missing'}, not pass`)
      }
      return {
        kind: 'ready',
        mergedCommit,
        facts: {
          cardId: lease.cardId,
          description: pull.body ?? '',
          headRef: pull.head?.ref ?? '',
          title: pull.title ?? '',
          files: changedFiles(meter, lease.pr!),
          ownerMergesText: ownerMergesText(meter),
          shardActive: shardActive(this.parts.db, this.parts.run),
        },
      }
    }
    catch (error) {
      return technical('github_error', messageOf(error))
    }
  }

  private mergedAtLeasedHead(pull: Pull, lease: Lease): string | null {
    if (pull.state === 'closed' && pull.merged === true && pull.head?.sha === lease.head && isFullSha(pull.merge_commit_sha))
      return pull.merge_commit_sha
    return null
  }

  private versionLock(lease: Lease): MergeDenial | null {
    try {
      const meter = new Meter(this.parts.gitHub, () => this.parts.clock().getTime())
      const open = meter.get(`${REPO}/pulls?state=open&per_page=${OPEN_PULLS_PAGE}`) as Pull[]
      const versionPr = open.find(candidate => candidate.number !== lease.pr && VERSION_BRANCH.test(candidate.head?.ref ?? '') && approvedRunsOn(meter, candidate.head?.sha))
      return versionPr === undefined ? null : { kind: 'technical', reason: 'version_pr_open', detail: `#${versionPr.number} is a version pull request with approved runs on ${versionPr.head?.sha} and locks every merge` }
    }
    catch (error) {
      return { kind: 'technical', reason: 'github_error', detail: messageOf(error) }
    }
  }

  private finished(lease: Lease, commit: string, rule: AllowedRule): MergeOutcome {
    completeTask(this.parts.db, this.ts(), lease, [this.done(lease, commit, rule)])
    return { kind: 'merged', taskKey: lease.taskKey, commit, rule }
  }

  private merged(lease: Lease, rule: AllowedRule): MergeOutcome {
    let response
    try {
      response = this.parts.put(`${REPO}/pulls/${lease.pr}/merge`, { sha: lease.head!, merge_method: MERGE_METHOD })
    }
    catch (error) {
      return this.denied(lease, { kind: 'technical', reason: 'github_error', detail: messageOf(error) })
    }
    if (response.status === STALE_HEAD_STATUS)
      return this.denied(lease, { kind: 'technical', reason: 'stale_head', detail: `GitHub answered ${response.status}: the head of #${lease.pr} is no longer ${lease.head}` })
    const commit = (response.body as { sha?: unknown } | null)?.sha
    if (response.status !== 200 || !isFullSha(commit))
      return this.denied(lease, { kind: 'technical', reason: 'github_error', detail: `GitHub answered ${response.status} to the merge of #${lease.pr}` })
    return this.finished(lease, commit, rule)
  }

  private done(lease: Lease, commit: string, rule: AllowedRule): BusEvent {
    return { ts: this.ts(), type: MERGE_DONE, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${MERGE_DONE}:${lease.taskKey}`, payload: { commit, rule }, legacy: false }
  }

  private denied(lease: Lease, denial: MergeDenial): MergeOutcome {
    const ts = this.ts()
    const reason = denial.kind === 'technical' ? denial.reason : denial.rule
    const event: BusEvent = { ts, type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'merge', ...denial }, legacy: false }
    if (denial.kind === 'technical' && WAIT_REASONS.has(denial.reason)) {
      releaseTask(this.parts.db, ts, lease, reason, [event])
      return { kind: 'denied', taskKey: lease.taskKey, denial, next: 'queued' }
    }
    const next = failTask(this.parts.db, ts, lease, { reason, withdraw: denial.kind === 'authority' }, [event])
    return { kind: 'denied', taskKey: lease.taskKey, denial, next }
  }
}

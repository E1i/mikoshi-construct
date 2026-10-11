import type { GhResponse, GitHub, GitHubPut } from '../../bus/github.js'
import type { ReviewStatus, StatusPublisher } from '../../ghosts/verdict.js'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'

export const REPO = 'repos/{owner}/{repo}'
export const sha = (digit: string): string => digit.repeat(40)
export const MAIN_1 = sha('1')
export const MAIN_2 = sha('2')
export const MAIN_3 = sha('3')
export const MERGER = { login: 'the-owner', at: '2026-10-09T11:30:00Z' }

export interface FakeMerger {
  login: string
  at: string
}

export interface FakeRun {
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: 'action_required' | 'success' | 'failure' | null
}

export interface FakePull {
  number: number
  state: 'open' | 'closed'
  head: string
  mergeable_state: string
  merged?: boolean
  merge_commit_sha?: string
  merger?: FakeMerger
  draft?: boolean
  required?: 'pending' | 'success' | 'failure'
  failed?: string[]
  review?: 'success' | 'failure'
  body?: string
  ref?: string
  base?: string
  title?: string
  files?: string[]
  patches?: Record<string, string>
  runs?: FakeRun[]
}

export function cardBody(pr: number, decision = 'auto'): string {
  return `#${pr + 100} a-card [implement/netwatch/M/cheap/${decision}] · depends — · blocks —`
}

export class FakeGitHub {
  pulls = new Map<number, FakePull>()
  main = MAIN_1
  mainFiles: Record<string, string[]> = {}
  limited: GhResponse | null = null
  failing = false
  calls: string[] = []
  remaining = 5000
  ownerMerges = readFileSync('architecture/owner-merges.md', 'utf8')
  mergeStatus = 200
  puts: { endpoint: string, fields: Record<string, string> }[] = []
  updateStatus = 202
  updatedHead = sha('d')
  updatedPatches: Record<string, string> | null = null
  parents = new Map<string, string[]>()
  statuses = new Map<string, ReviewStatus['state']>()
  published: ReviewStatus[] = []

  readonly publish: StatusPublisher = (status) => {
    this.published.push(status)
    this.statuses.set(status.commit, status.state)
  }

  readonly client: GitHub = (endpoint) => {
    this.calls.push(endpoint)
    if (this.failing)
      throw new Error('gh api: connection refused')
    if (this.limited !== null)
      return this.limited
    this.remaining -= 1
    return { status: 200, headers: { 'x-ratelimit-remaining': String(this.remaining) }, body: this.answer(endpoint) }
  }

  open(pull: Partial<FakePull> & { number: number }): void {
    this.pulls.set(pull.number, { state: 'open', head: sha('a'), mergeable_state: 'clean', required: 'success', ...pull })
  }

  close(pr: number, merged: boolean, merger: FakeMerger | null = merged ? MERGER : null): void {
    this.pulls.set(pr, { ...this.pulls.get(pr)!, state: 'closed', merged, ...(merged ? { merge_commit_sha: MAIN_2 } : {}), ...(merger === null ? {} : { merger }) })
  }

  private pullBody(pull: FakePull): object {
    return {
      number: pull.number,
      state: pull.state,
      draft: pull.draft ?? false,
      title: pull.title ?? `feat: card #${pull.number + 100}`,
      body: pull.body ?? cardBody(pull.number),
      merged: pull.merged ?? false,
      merge_commit_sha: pull.merge_commit_sha ?? null,
      merged_by: pull.merger === undefined ? null : { login: pull.merger.login },
      merged_at: pull.merger?.at ?? null,
      mergeable_state: pull.mergeable_state,
      auto_merge: null,
      base: { ref: pull.base ?? 'main' },
      head: { sha: pull.head, ref: pull.ref ?? `feat/card-${pull.number + 100}` },
    }
  }

  readonly put: GitHubPut = (endpoint, fields) => {
    this.puts.push({ endpoint, fields })
    const update = /^repos\/\{owner\}\/\{repo\}\/pulls\/(\d+)\/update-branch$/.exec(endpoint)
    if (update !== null)
      return this.updateBranch(this.pulls.get(Number(update[1]))!, fields.expected_head_sha)
    const merge = /^repos\/\{owner\}\/\{repo\}\/pulls\/(\d+)\/merge$/.exec(endpoint)
    const pull = merge === null ? undefined : this.pulls.get(Number(merge[1]))
    if (pull === undefined)
      throw new Error(`the fake has no answer for PUT ${endpoint}`)
    if (this.mergeStatus !== 200)
      return { status: this.mergeStatus, headers: {}, body: { message: 'Head branch was modified. Review and try the merge again.' } }
    if (fields.sha !== pull.head)
      return { status: 409, headers: {}, body: { message: 'Head branch was modified. Review and try the merge again.' } }
    this.close(pull.number, true)
    return { status: 200, headers: {}, body: { sha: MAIN_2, merged: true } }
  }

  private updateBranch(pull: FakePull, expected: string | undefined): GhResponse {
    if (this.updateStatus !== 202)
      return { status: this.updateStatus, headers: {}, body: { message: 'merge conflict between base and head' } }
    if (expected !== pull.head)
      return { status: 422, headers: {}, body: { message: 'expected head sha didn\'t match current head ref.' } }
    this.parents.set(this.updatedHead, [pull.head, this.main])
    this.pulls.set(pull.number, { ...pull, head: this.updatedHead, mergeable_state: 'clean', review: undefined, patches: this.updatedPatches ?? pull.patches })
    return { status: 202, headers: {}, body: { message: 'Updating pull request branch.' } }
  }

  private answer(endpoint: string): unknown {
    if (endpoint === `${REPO}/pulls?state=open&per_page=100`)
      return [...this.pulls.values()].filter(pull => pull.state === 'open').map(pull => ({ ...this.pullBody(pull), mergeable_state: undefined }))
    const pull = /^repos\/\{owner\}\/\{repo\}\/pulls\/(\d+)$/.exec(endpoint)
    if (pull !== null)
      return this.pullBody(this.pulls.get(Number(pull[1]))!)
    const files = /^repos\/\{owner\}\/\{repo\}\/pulls\/(\d+)\/files\?per_page=100&page=(\d+)$/.exec(endpoint)
    if (files !== null) {
      const listed = this.pulls.get(Number(files[1]))!
      return Number(files[2]) === 1 ? (listed.files ?? []).map(filename => ({ filename, status: 'modified', patch: listed.patches?.[filename] ?? `@@ -1 +1 @@ ${filename}` })) : []
    }
    if (endpoint === `${REPO}/contents/architecture/owner-merges.md?ref=main`)
      return { content: Buffer.from(this.ownerMerges).toString('base64') }
    const checks = /\/commits\/([0-9a-f]{40})\/check-runs/.exec(endpoint)
    if (checks !== null) {
      const owner = [...this.pulls.values()].find(candidate => candidate.head === checks[1])
      const required = owner?.required ?? 'pending'
      const failed = (owner?.failed ?? []).map(name => ({ name, status: 'completed', conclusion: 'failure' }))
      return { check_runs: [{ name: 'required', status: required === 'pending' ? 'in_progress' : 'completed', conclusion: required === 'pending' ? null : required }, ...failed] }
    }
    const status = /\/commits\/([0-9a-f]{40})\/status$/.exec(endpoint)
    if (status !== null) {
      const owner = [...this.pulls.values()].find(candidate => candidate.head === status[1])
      const state = this.statuses.get(status[1]) ?? owner?.review
      return { statuses: state === undefined ? [] : [{ context: 'review', state }] }
    }
    const runs = /\/actions\/runs\?head_sha=([0-9a-f]{40})&per_page=100$/.exec(endpoint)
    if (runs !== null) {
      const owner = [...this.pulls.values()].find(candidate => candidate.head === runs[1])
      return { workflow_runs: owner?.runs ?? [] }
    }
    const commit = /\/commits\/([0-9a-f]{40})$/.exec(endpoint)
    if (commit !== null)
      return { sha: commit[1], parents: (this.parents.get(commit[1]) ?? [MAIN_1]).map(parent => ({ sha: parent })) }
    if (endpoint === `${REPO}/commits/main`)
      return { sha: this.main, files: (this.mainFiles[this.main] ?? []).map(filename => ({ filename })) }
    const compare = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(endpoint)
    if (compare !== null)
      return { files: Object.entries(this.mainFiles).filter(([commit]) => commit > compare[1] && commit <= compare[2]).flatMap(([, files]) => files.map(filename => ({ filename }))) }
    throw new Error(`the fake has no answer for ${endpoint}`)
  }
}

export class Clock {
  constructor(public ms = Date.parse('2026-10-09T12:00:00.000Z')) {}
  advance(ms: number): void {
    this.ms += ms
  }

  readonly now = (): Date => new Date(this.ms)
}

import type { GhResponse, GitHub } from '../../bus/github.js'

export const REPO = 'repos/{owner}/{repo}'
export const sha = (digit: string): string => digit.repeat(40)
export const MAIN_1 = sha('1')
export const MAIN_2 = sha('2')
export const MAIN_3 = sha('3')

export interface FakePull {
  number: number
  state: 'open' | 'closed'
  head: string
  mergeable_state: string
  merged?: boolean
  merge_commit_sha?: string
  draft?: boolean
  required?: 'pending' | 'success' | 'failure'
  review?: 'success' | 'failure'
}

export class FakeGitHub {
  pulls = new Map<number, FakePull>()
  main = MAIN_1
  mainFiles: Record<string, string[]> = {}
  limited: GhResponse | null = null
  failing = false
  calls: string[] = []
  remaining = 5000

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

  close(pr: number, merged: boolean): void {
    this.pulls.set(pr, { ...this.pulls.get(pr)!, state: 'closed', merged, ...(merged ? { merge_commit_sha: MAIN_2 } : {}) })
  }

  private pullBody(pull: FakePull): object {
    return {
      number: pull.number,
      state: pull.state,
      draft: pull.draft ?? false,
      body: `#${pull.number + 100} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —`,
      merged: pull.merged ?? false,
      merge_commit_sha: pull.merge_commit_sha ?? null,
      mergeable_state: pull.mergeable_state,
      auto_merge: null,
      base: { ref: 'main' },
      head: { sha: pull.head },
    }
  }

  private answer(endpoint: string): unknown {
    if (endpoint === `${REPO}/pulls?state=open&per_page=100`)
      return [...this.pulls.values()].filter(pull => pull.state === 'open').map(pull => ({ ...this.pullBody(pull), mergeable_state: undefined }))
    const pull = /^repos\/\{owner\}\/\{repo\}\/pulls\/(\d+)$/.exec(endpoint)
    if (pull !== null)
      return this.pullBody(this.pulls.get(Number(pull[1]))!)
    const checks = /\/commits\/([0-9a-f]{40})\/check-runs/.exec(endpoint)
    if (checks !== null) {
      const owner = [...this.pulls.values()].find(candidate => candidate.head === checks[1])
      const required = owner?.required ?? 'pending'
      return { check_runs: [{ name: 'required', status: required === 'pending' ? 'in_progress' : 'completed', conclusion: required === 'pending' ? null : required }] }
    }
    const status = /\/commits\/([0-9a-f]{40})\/status$/.exec(endpoint)
    if (status !== null) {
      const owner = [...this.pulls.values()].find(candidate => candidate.head === status[1])
      return { statuses: owner?.review === undefined ? [] : [{ context: 'review', state: owner.review }] }
    }
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

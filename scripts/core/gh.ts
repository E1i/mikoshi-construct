import { spawnSync } from 'node:child_process'

export type GhRunner = (args: string[]) => string

export type GhFailureCause = 'timeout' | 'transient' | 'failed' | 'budget'

export type GhCall = { kind: 'ran', stdout: string, attempts: number }
  | { kind: 'failed', cause: GhFailureCause, reason: string, stdout: string, stderr: string, attempts: number, retryAfterSeconds?: number }

export interface GhSpawned {
  status: number | null
  stdout: string
  stderr: string
  error?: NodeJS.ErrnoException
}

export interface GhSpawnOptions {
  cwd?: string
  input?: string
  timeoutMs: number
}

export type GhSpawn = (command: string, args: string[], options: GhSpawnOptions) => GhSpawned

export interface GhBudget {
  calls: number
  windowMs: number
}

export interface GhPortOptions {
  command: string
  timeoutSeconds: number
  attempts: number
  pauseMs: number
  budget: GhBudgetWindow
  spawn: GhSpawn
  pause: (ms: number) => void
}

export interface GhCallOptions {
  cwd?: string
  input?: string
}

const TRANSIENT_STDERR = /HTTP 5\d\d|HTTP 403|\bTLS\b|tls:|ETIMEDOUT|i\/o timeout|connection reset/i

export const GH_TIMEOUT_SECONDS = 20
export const GH_ATTEMPTS = 3
export const GH_PAUSE_MS = 2000
export const GH_HOURLY_BUDGET: GhBudget = { calls: 2000, windowMs: 3_600_000 }

function spawnGh(command: string, args: string[], options: GhSpawnOptions): GhSpawned {
  const run = spawnSync(command, args, { cwd: options.cwd, input: options.input, encoding: 'utf8', stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: options.timeoutMs, killSignal: 'SIGKILL' })
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', error: run.error }
}

function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function callOutcome(run: GhSpawned, args: string[], timeoutSeconds: number, attempts: number): GhCall {
  const failed = (cause: GhFailureCause, reason: string): GhCall => ({ kind: 'failed', cause, reason, stdout: run.stdout, stderr: run.stderr, attempts })
  if (run.error?.code === 'ETIMEDOUT')
    return failed('timeout', `gh timed out after ${timeoutSeconds} s`)
  if (run.error !== undefined)
    return failed(TRANSIENT_STDERR.test(run.error.message) ? 'transient' : 'failed', `gh ${args.join(' ')}: ${run.error.message}`)
  if (run.status === 0)
    return { kind: 'ran', stdout: run.stdout, attempts }
  const detail = run.stderr.trim() === '' ? `exit ${run.status ?? 'signal'}` : run.stderr.trim()
  return failed(TRANSIENT_STDERR.test(run.stderr) ? 'transient' : 'failed', `gh ${args.join(' ')}: ${detail}`)
}

export type GhSpend = { kind: 'spent' } | { kind: 'spent-out', reason: string, retryAfterSeconds: number }

export class GhBudgetWindow {
  private readonly spent: number[] = []

  constructor(private readonly budget: GhBudget, private readonly now: () => number) {}

  spend(): GhSpend {
    const now = this.now()
    while (this.spent.length > 0 && this.spent[0]! <= now - this.budget.windowMs)
      this.spent.shift()
    if (this.spent.length < this.budget.calls) {
      this.spent.push(now)
      return { kind: 'spent' }
    }
    const freedAt = this.spent[0]! + this.budget.windowMs
    return { kind: 'spent-out', reason: `the gh budget of ${this.budget.calls} calls per ${this.budget.windowMs / 1000} s is spent`, retryAfterSeconds: Math.max(1, Math.ceil((freedAt - now) / 1000)) }
  }
}

export const PROCESS_GH_BUDGET = new GhBudgetWindow(GH_HOURLY_BUDGET, Date.now)

export class GhPort {
  constructor(private readonly options: GhPortOptions) {}

  call(args: string[], call: GhCallOptions = {}): GhCall {
    for (let attempt = 1; ; attempt += 1) {
      const spend = this.options.budget.spend()
      if (spend.kind === 'spent-out')
        return { kind: 'failed', cause: 'budget', reason: spend.reason, stdout: '', stderr: '', attempts: attempt - 1, retryAfterSeconds: spend.retryAfterSeconds }
      const outcome = callOutcome(this.options.spawn(this.options.command, args, { ...call, timeoutMs: this.options.timeoutSeconds * 1000 }), args, this.options.timeoutSeconds, attempt)
      if (outcome.kind === 'ran' || outcome.cause === 'failed' || attempt >= this.options.attempts)
        return outcome
      this.options.pause(this.options.pauseMs * attempt)
    }
  }
}

export function ghPort(overrides: Partial<GhPortOptions> = {}): GhPort {
  return new GhPort({ command: 'gh', timeoutSeconds: GH_TIMEOUT_SECONDS, attempts: GH_ATTEMPTS, pauseMs: GH_PAUSE_MS, budget: PROCESS_GH_BUDGET, spawn: spawnGh, pause: blockFor, ...overrides })
}

export const PROCESS_GH_PORT = ghPort()

export interface PullRequest {
  number: number
  title?: string
  headRefName: string
  headRefOid: string
  state: string
  mergedAt: string | null
  mergeCommit: { oid: string } | null
}

export type PrList = { kind: 'failed', reason?: string } | { kind: 'listed', prs: PullRequest[], truncated: boolean }

export type PrLookup = { kind: 'found', pr: PullRequest } | { kind: 'none' } | { kind: 'unknown', missing: string }

interface Check {
  name?: string
  status?: string
  conclusion?: string
  state?: string
  completedAt?: string
}

export const PR_LIST_LIMIT = 1000

const PASSING = ['SUCCESS', 'SKIPPED', 'NEUTRAL']

const GH_QUERY_FAILED = 'the gh query failed'

export class GhTimedOut extends Error {
  constructor(seconds: number) {
    super(`gh timed out after ${seconds} s`)
  }
}

export class GhFailed extends Error {
  readonly stderr: string

  constructor(failure: Extract<GhCall, { kind: 'failed' }>) {
    super(failure.reason)
    this.stderr = failure.stderr
  }
}

export function ghRunner(timeoutSeconds: number, command = 'gh', port: GhPort = ghPort({ command, timeoutSeconds })): GhRunner {
  let expired: GhTimedOut | undefined
  return (args) => {
    if (expired !== undefined)
      throw expired
    const result = port.call(args)
    if (result.kind === 'ran')
      return result.stdout
    if (result.cause === 'timeout')
      throw (expired = new GhTimedOut(timeoutSeconds))
    throw new GhFailed(result)
  }
}

export const execGh: GhRunner = ghRunner(GH_TIMEOUT_SECONDS)

function reasonOf(error: unknown): string {
  return error instanceof GhTimedOut ? error.message : GH_QUERY_FAILED
}

export function listPrs(gh: GhRunner, repo: string): PrList {
  try {
    const prs = JSON.parse(gh(['pr', 'list', '-R', repo, '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', 'number,title,headRefName,headRefOid,state,mergedAt,mergeCommit'])) as PullRequest[]
    return { kind: 'listed', prs, truncated: prs.length >= PR_LIST_LIMIT }
  }
  catch (error) {
    return error instanceof GhTimedOut ? { kind: 'failed', reason: error.message } : { kind: 'failed' }
  }
}

export function lookupPr(list: PrList, branch: string | undefined): PrLookup {
  if (branch === undefined)
    return { kind: 'unknown', missing: 'branch; no tasks file names one' }
  if (list.kind === 'failed')
    return { kind: 'unknown', missing: `pr; ${list.reason ?? GH_QUERY_FAILED}` }
  const pr = list.prs.find(candidate => candidate.headRefName === branch)
  if (pr !== undefined)
    return { kind: 'found', pr }
  if (list.truncated)
    return { kind: 'unknown', missing: `pr; the gh list stopped at ${PR_LIST_LIMIT}` }
  return { kind: 'none' }
}

export type CiState = 'none' | 'pending' | 'red' | 'green' | 'unknown'

export const REQUIRED_CHECK = 'required'

export interface Ci {
  state: CiState
  text: string
  head: string
  greenAt?: string
}

export interface PrDetails {
  ci: Ci
  files: string[] | undefined
}

function outcomeOf(check: Check): string | undefined {
  return check.conclusion ?? check.state
}

function isFailing(check: Check): boolean {
  const outcome = outcomeOf(check)
  return outcome !== undefined && outcome !== '' && !PASSING.includes(outcome)
}

function ciOf(checks: Check[], head: string): Ci {
  if (checks.length === 0)
    return { state: 'none', text: `— (no checks recorded on ${head})`, head }
  const required = checks.find(check => check.name === REQUIRED_CHECK)
  if (required === undefined)
    return { state: 'pending', text: `pending (${REQUIRED_CHECK} not reported) on ${head}`, head }
  const pending = checks.filter(check => check.status !== undefined && check.status !== 'COMPLETED')
  if (pending.includes(required))
    return { state: 'pending', text: `pending (${pending.length} of ${checks.length}) on ${head}`, head }
  if (outcomeOf(required) !== 'SUCCESS') {
    const failing = checks.filter(check => check === required || isFailing(check))
    return { state: 'red', text: `red (${failing.map(check => check.name ?? '?').join(', ')}) on ${head}`, head }
  }
  const at = required.completedAt
  return at === undefined
    ? { state: 'green', text: `green on ${head}`, head }
    : { state: 'green', text: `green ${at} on ${head}`, head, greenAt: at }
}

export function prDetails(gh: GhRunner, repo: string, pr: PullRequest): PrDetails {
  let view: { headRefOid?: string, statusCheckRollup?: Check[], files?: { path: string }[] }
  try {
    view = JSON.parse(gh(['pr', 'view', String(pr.number), '-R', repo, '--json', 'headRefOid,statusCheckRollup,files'])) as typeof view
  }
  catch (error) {
    return { ci: { state: 'unknown', text: `UNKNOWN (missing: checks; ${reasonOf(error)})`, head: pr.headRefOid.slice(0, 7) }, files: undefined }
  }
  return { ci: ciOf(view.statusCheckRollup ?? [], (view.headRefOid ?? pr.headRefOid).slice(0, 7)), files: view.files?.map(file => file.path) }
}

import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { GH_ACCOUNT_VARIABLE } from '../core/bus-path.js'

export const TECHNOLOGY_WORDS = ['errno', 'exec', 'gh', 'spawn', 'stderr', 'stdout'] as const

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
  env?: NodeJS.ProcessEnv
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
  environment: NodeJS.ProcessEnv
}

export interface GhCallOptions {
  cwd?: string
  input?: string
  env?: NodeJS.ProcessEnv
}

const TRANSIENT_STDERR = /HTTP 5\d\d|HTTP 403|\bTLS\b|tls:|ETIMEDOUT|i\/o timeout|connection reset/i

export const GH_TIMEOUT_SECONDS = 20
export const GH_ATTEMPTS = 3
export const GH_PAUSE_MS = 2000
export const GH_HOURLY_BUDGET: GhBudget = { calls: 2000, windowMs: 3_600_000 }
const GH_OUTPUT_BOUND_BYTES = 256 * 1024 * 1024

function spawnGh(command: string, args: string[], options: GhSpawnOptions): GhSpawned {
  const run = spawnSync(command, args, { cwd: options.cwd, input: options.input, env: options.env, encoding: 'utf8', stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: GH_OUTPUT_BOUND_BYTES })
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

export function recordedAccount(env: NodeJS.ProcessEnv): string | null {
  const account = env[GH_ACCOUNT_VARIABLE]
  return account === undefined || account === '' ? null : account
}

export type GhAccountToken = { kind: 'token', token: string } | { kind: 'failed', reason: string, stderr: string }

export function accountToken(account: string, options: { command?: string, spawn?: GhSpawn, timeoutMs?: number } = {}): GhAccountToken {
  const run = (options.spawn ?? spawnGh)(options.command ?? 'gh', ['auth', 'token', '--user', account], { timeoutMs: options.timeoutMs ?? GH_TIMEOUT_SECONDS * 1000 })
  const token = run.stdout.trim()
  if (run.error === undefined && run.status === 0 && token !== '')
    return { kind: 'token', token }
  const detail = run.error?.message ?? (run.stderr.trim() || `exit ${run.status ?? 'signal'}`)
  return { kind: 'failed', reason: `gh holds no token of the account ${account} this factory records: ${detail}; run gh auth login and sign in as ${account}`, stderr: run.stderr }
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

  private asRecordedAccount(call: GhCallOptions): { call: GhCallOptions } | { refused: GhCall } {
    const account = recordedAccount(this.options.environment)
    if (account === null)
      return { call }
    const token = accountToken(account, { command: this.options.command, spawn: this.options.spawn, timeoutMs: this.options.timeoutSeconds * 1000 })
    if (token.kind === 'failed')
      return { refused: { kind: 'failed', cause: 'failed', reason: token.reason, stdout: '', stderr: token.stderr, attempts: 0 } }
    return { call: { ...call, env: { ...(call.env ?? this.options.environment), GH_TOKEN: token.token } } }
  }

  call(args: string[], asked: GhCallOptions = {}): GhCall {
    const resolved = this.asRecordedAccount(asked)
    if ('refused' in resolved)
      return resolved.refused
    const { call } = resolved
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
  return new GhPort({ command: 'gh', timeoutSeconds: GH_TIMEOUT_SECONDS, attempts: GH_ATTEMPTS, pauseMs: GH_PAUSE_MS, budget: PROCESS_GH_BUDGET, spawn: spawnGh, pause: blockFor, environment: process.env, ...overrides })
}

export const PROCESS_GH_PORT = ghPort()

export type GhAnswer = string | GhSpawned

export interface GhCalled {
  args: string[]
  options: GhSpawnOptions
}

export class InMemoryGh {
  readonly calls: GhCalled[] = []

  constructor(private readonly answer: (args: readonly string[]) => GhAnswer) {}

  readonly spawn: GhSpawn = (_command, args, options) => {
    this.calls.push({ args: [...args], options })
    const answered = this.answer(args)
    return typeof answered === 'string' ? { status: 0, stdout: answered, stderr: '' } : answered
  }

  port(overrides: Partial<GhPortOptions> = {}): GhPort {
    return ghPort({ spawn: this.spawn, pause: () => {}, environment: {}, budget: new GhBudgetWindow(GH_HOURLY_BUDGET, () => 0), ...overrides })
  }

  caller(overrides: Partial<GhPortOptions> = {}): GhCaller {
    const port = this.port(overrides)
    return args => port.call(args)
  }
}

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

export const PR_LIST_LIMIT = 1000

export const GH_QUERY_FAILED = 'the gh query failed'

export class GhFailed extends Error {
  readonly stderr: string

  constructor(failure: Extract<GhCall, { kind: 'failed' }>) {
    super(failure.reason)
    this.stderr = failure.stderr
  }
}

export class GhTimedOut extends GhFailed {}

export type GhCaller = (args: string[]) => GhCall

export function ghRunner(timeoutSeconds: number, command = 'gh', port: GhPort = ghPort({ command, timeoutSeconds })): GhCaller {
  let expired: GhCall | undefined
  return (args) => {
    if (expired !== undefined)
      return expired
    const result = port.call(args)
    if (result.kind === 'failed' && result.cause === 'timeout')
      expired = result
    return result
  }
}

export const execGh: GhCaller = ghRunner(GH_TIMEOUT_SECONDS)

export function stdoutOrThrow(gh: GhCaller): GhRunner {
  return (args) => {
    const result = gh(args)
    if (result.kind === 'ran')
      return result.stdout
    throw result.cause === 'timeout' ? new GhTimedOut(result) : new GhFailed(result)
  }
}

export type GhRead<T> = { kind: 'read', value: T } | { kind: 'failed', reason: string, cause: GhFailureCause | 'unparsed' }

export function readGhJson<T>(gh: GhCaller, args: string[]): GhRead<T> {
  const result = gh(args)
  if (result.kind === 'failed')
    return { kind: 'failed', reason: result.reason, cause: result.cause }
  try {
    return { kind: 'read', value: JSON.parse(result.stdout) as T }
  }
  catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error), cause: 'unparsed' }
  }
}

export function listPrs(gh: GhCaller, repo: string): PrList {
  const read = readGhJson<PullRequest[]>(gh, ['pr', 'list', '-R', repo, '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', 'number,title,headRefName,headRefOid,state,mergedAt,mergeCommit'])
  if (read.kind === 'failed')
    return read.cause === 'timeout' ? { kind: 'failed', reason: read.reason } : { kind: 'failed' }
  return { kind: 'listed', prs: read.value, truncated: read.value.length >= PR_LIST_LIMIT }
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

export { REQUIRED_CHECK, SECRET_SCAN_CHECK } from '../../src/commands/ci/state.js'

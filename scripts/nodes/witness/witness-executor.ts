import type { ChildProcess } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import type { CardScope } from '../../../src/commands/test-runner.js'
import type { ServeRecord } from '../../../src/presets/index.js'
import type { BusEvent } from '../../core/db.js'
import type { AfterFailure, Lease } from '../../core/lease.js'
import type { IdentityReader } from '../../core/node.js'
import type { VERIFICATION_WORDS } from '../../core/verification.js'
import type { WitnessSubject, WitnessVerdict } from '../../policy/policy.js'
import type { BaseRun, ReplacementField, Witness } from '../../ports/witnesses.js'
import type { GitAsync, ShellResult } from '../../ports/worktree.js'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { CARD_ADMITTED, CARD_CLOSED, CARD_CONTINUED, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, POLICY_DENIED, QUESTION_AGENT, WITNESS_RECORDED } from '../../core/events.js'
import { isFullSha } from '../../core/identifiers.js'
import { assertHeld, completeTask, failTask, RENEW_MS, StaleLease } from '../../core/lease.js'
import { instanceOf, recordChildEnded, recordChildStarted } from '../../core/node.js'
import { baseOfKey, LEASE_MS } from '../../core/queue.js'
import { GREEN, RED, UNCHECKED, witnessSubjectOf } from '../../policy/policy.js'
import { execGh, stdoutOrThrow } from '../../ports/gh.js'
import { serveRecordAt } from '../../ports/serve-record.js'
import { witnessEnv } from '../../ports/session.js'
import { BASE_PHASE, cardScopeOfAdmitted, namedOutsideTheCard, redOnMainProposal, runOnTreeAsync, witnessesFindingNoTest } from '../../ports/witnesses.js'
import { gitIn, gitInAsync, SetupTurns, withWorktreeAsync } from '../../ports/worktree.js'

export const WITNESS_UNRUN = 'witness_unrun'
export const WITNESS_KIND = 'witness'
export const WITNESS_NO_SERVE = 'witness_no_serve'
export const WITNESS_BUDGET_MS = LEASE_MS - RENEW_MS
const SHELL_BUFFER = 1 << 28
const LOCKFILE = 'pnpm-lock.yaml'
const INSTALL = 'pnpm install --frozen-lockfile'
const VERIFIED_BY_RUNNING_WITNESSES: typeof VERIFICATION_WORDS[number] = 'run'

export interface TimedShellResult extends ShellResult { timedOut: boolean }
export type TimedShell = (command: string, cwd: string, timeoutMs: number, started?: (pid: number) => void) => Promise<TimedShellResult>

const GROUP_KILL_GRACE_MS = 10_000
const OUTPUT_OVER_BUFFER = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
const GROUP_RUNNER = [
  `const { spawn } = require('node:child_process')`,
  `const { constants } = require('node:os')`,
  `const [budget, command] = process.argv.slice(1)`,
  `const child = spawn('bash', ['-c', command], { detached: true, stdio: 'inherit' })`,
  `const timer = setTimeout(() => {`,
  `  try { process.kill(-child.pid, 'SIGKILL') } catch {}`,
  `  process.kill(process.pid, 'SIGKILL')`,
  `}, Number(budget))`,
  `child.on('error', () => process.exit(127))`,
  `child.on('exit', (code, signal) => {`,
  `  clearTimeout(timer)`,
  `  process.exit(code ?? 128 + (constants.signals[signal] ?? 0))`,
  `})`,
].join('\n')

function timedResultOf(error: (Error & { code?: number | string | null, signal?: string | null }) | null, stdout: string, stderr: string): TimedShellResult {
  const status = error === null ? 0 : typeof error.code === 'number' ? error.code : null
  const timedOut = error?.signal === 'SIGKILL' || error?.code === OUTPUT_OVER_BUFFER
  return { status, output: `${stdout}${stderr}`, timedOut }
}

export async function realTimedShell(command: string, cwd: string, timeoutMs: number, started?: (pid: number) => void): Promise<TimedShellResult> {
  const budget = String(Math.max(1, Math.floor(timeoutMs)))
  return new Promise((resolve) => {
    const runner = execFile(process.execPath, ['-e', GROUP_RUNNER, budget, command], { cwd, env: witnessEnv(), encoding: 'utf8', maxBuffer: SHELL_BUFFER, timeout: timeoutMs + GROUP_KILL_GRACE_MS, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      resolve(timedResultOf(error, stdout, stderr))
    })
    if (runner.pid !== undefined)
      started?.(runner.pid)
  })
}

export interface WitnessTrees {
  baseOf: (pr: number, head: string) => Promise<string>
  withTree: <T>(base: string, run: (tree: string) => Promise<T>) => Promise<T>
}

export interface WitnessParts {
  db: DatabaseSync
  clock: () => Date
  silentMs: number
  trees: WitnessTrees
  shell: TimedShell
  log: (line: string) => void
  identity?: IdentityReader
}

export const UNFIT = 'unfit'
export const WITNESS_UNFIT = 'witness_unfit'

export type NodeVerdict = WitnessVerdict | typeof UNFIT

type BaseJudgement
  = | { kind: 'green' }
    | { kind: 'red', detail: string }
    | { kind: 'unfit', why: string[], replacement: ReplacementField[] | null, files: string[] }

const LATEST_ADMITTED_TEXT = `
  SELECT json_extract(payload, '$.text') AS text FROM events
  WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND card_id = ? AND json_type(payload, '$.text') = 'text'
  ORDER BY id DESC LIMIT 1
`

function cardScopeOf(db: DatabaseSync, subject: WitnessSubject): CardScope | null {
  const row = db.prepare(LATEST_ADMITTED_TEXT).get(subject.cardId) as { text: string } | undefined
  return row === undefined ? null : cardScopeOfAdmitted(subject.cardId, row.text, subject.creates)
}

function changedOnHead(tree: string, base: string, head: string): string[] {
  try {
    return gitIn(tree, ['diff', '--name-only', '--diff-filter=d', base, head]).split('\n').filter(file => file !== '')
  }
  catch (error) {
    throw new WitnessNotRun(`the diff of ${head} against the base ${base} could not be read, so no witness is judged unfit on a guess: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

function unfitJudgement(why: string[], unfit: readonly Witness[], witnesses: readonly Witness[], changed: readonly string[]): BaseJudgement {
  return { kind: 'unfit', why, ...redOnMainProposal(unfit, witnesses, changed) }
}

export type WitnessOutcome
  = | { kind: 'recorded', taskKey: string, verdict: NodeVerdict, base: string, detail: string, replacement?: ReplacementField[] | null }
    | { kind: 'skipped', taskKey: string, why: string }
    | { kind: 'denied', taskKey: string, denial: { kind: 'technical', reason: string, detail: string }, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

class WitnessRed extends Error {
  constructor(readonly step: string, readonly problem: string) {
    super(`${step}: ${problem}`)
  }
}

class WitnessNotRun extends Error {}

class WitnessTimedOut extends WitnessNotRun {
  constructor(command: string) {
    super(`a witness command ran past the budget of ${WITNESS_BUDGET_MS} ms: ${command}`)
  }
}

class ServeAddressTaken extends WitnessNotRun {
  constructor(url: string) {
    super(`${url} already answers before the serve command starts, so a witness would read a server this node did not start`)
  }
}

class WitnessCouldNotCheck extends Error {}

class NoServeDeclared extends Error {
  constructor(command: string, head: string) {
    super(`a browser witness on a URL needs the repository's server, and there is no serve in construct.json at ${head} or in .construct/attach.json: declare serve: { command, url, readyTimeoutMs } in construct.json, or attach with --serve and --serve-url; nothing ran: ${command}`)
  }
}

const BROWSER_COMMAND = /(?:^|[\s/])browser-(?:lab|witness)\.mjs\s/
const URL_IN_COMMAND = /https?:\/\/[^\s'"`]+/g
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])
const SERVE_POLL_MS = 100
const SERVE_ATTEMPT_MS = 1_000
const SERVE_STOP_GRACE_MS = 2_000
const SERVE_STDERR_TAIL = 400

function needsServer(command: string, serve: ServeRecord | null): boolean {
  const urls = (command.match(URL_IN_COMMAND) ?? []).filter(url => URL.canParse(url)).map(url => new URL(url))
  return urls.some(url => LOOPBACK_HOSTS.has(url.hostname) || (serve !== null && url.origin === new URL(serve.url).origin))
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(SERVE_ATTEMPT_MS), redirect: 'manual' })
    await response.body?.cancel()
    return true
  }
  catch {
    return false
  }
}

interface RunningServer {
  child: ChildProcess
  stopped: Promise<void>
  exited: () => boolean
  stderr: () => string
}

function startServer(command: string, cwd: string): RunningServer {
  const child = spawn('bash', ['-c', command], { cwd, env: witnessEnv(), detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let exited = false
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-SERVE_STDERR_TAIL)
  })
  const stopped = new Promise<void>((resolve) => {
    const settle = (): void => {
      exited = true
      resolve()
    }
    child.once('error', settle)
    child.once('exit', settle)
  })
  return { child, stopped, exited: () => exited, stderr: () => stderr.trim() }
}

async function notAnswering(server: RunningServer, serve: ServeRecord, patienceMs: number): Promise<string | null> {
  const deadline = Date.now() + patienceMs
  while (Date.now() < deadline) {
    if (server.exited())
      return `the serve command "${serve.command}" exited before ${serve.url} answered: ${server.stderr() || 'no output'}`
    if (await answers(serve.url))
      return null
    await sleep(SERVE_POLL_MS)
  }
  return `${serve.url} did not answer within ${patienceMs} ms of the serve command "${serve.command}" starting`
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined)
    return
  try {
    process.kill(-child.pid, signal)
  }
  catch {}
}

async function stopServer(server: RunningServer): Promise<void> {
  signalGroup(server.child, 'SIGTERM')
  await Promise.race([server.stopped, sleep(SERVE_STOP_GRACE_MS)])
  signalGroup(server.child, 'SIGKILL')
  server.child.stderr?.destroy()
}

export const EXCERPT_LINES = 20
export const EXCERPT_CHARS = 2000
const FAILURE_LINE = /^\s*(?:FAIL|[×✗✘])|\b\w*Error\b/

export function failureExcerpt(output: string): string {
  const lines = stripVTControlCharacters(output).split('\n').filter(line => FAILURE_LINE.test(line))
  return lines.slice(0, EXCERPT_LINES).map(line => line.trimEnd()).join('\n').slice(0, EXCERPT_CHARS)
}

function withFailureExcerpt(message: string, result: ShellResult | null): string {
  if (result === null || result.status === 0)
    return message
  const excerpt = failureExcerpt(result.output)
  return excerpt === '' ? message : `${message}\n${excerpt}`
}

export interface WitnessTreePorts {
  git: GitAsync
  baseShaOf: (pr: number) => string
}

const REAL_TREE_PORTS: WitnessTreePorts = {
  git: gitInAsync,
  baseShaOf: pr => stdoutOrThrow(execGh)(['api', `repos/{owner}/{repo}/pulls/${pr}`, '--jq', '.base.sha']).trim(),
}

export function gitWitnessTrees(repo: string, ports: WitnessTreePorts = REAL_TREE_PORTS): WitnessTrees {
  const turns = new SetupTurns()
  return {
    baseOf: async (pr) => {
      await turns.take(() => ports.git(repo, ['fetch', '-q', 'origin', 'main', `pull/${pr}/head`]))
      const base = ports.baseShaOf(pr)
      if (!isFullSha(base))
        throw new Error(`GitHub named no base sha for #${pr}`)
      return base
    },
    withTree: (base, run) => withWorktreeAsync(repo, base, run, turns, ports.git),
  }
}

const SESSION_STARTS = `'${CARD_STARTED}', '${CARD_CONTINUED}'`
const SESSION_ENDS = `'${CARD_STOPPED}', '${CARD_SESSION_ENDED}'`

const LIVE_SESSION = `
  SELECT 1 FROM events AS started
  WHERE started.card_id = ? AND started.type IN (${SESSION_STARTS})
    AND started.id = (SELECT MAX(id) FROM events WHERE card_id = started.card_id AND legacy = 0 AND type IN (${SESSION_STARTS}))
    AND NOT EXISTS (SELECT 1 FROM events AS ended WHERE ended.card_id = started.card_id AND ended.legacy = 0 AND ended.id > started.id AND ended.type IN (${SESSION_ENDS}))
  LIMIT 1
`

const OPEN_PR_OF_ITS_OWN = `SELECT 1 FROM prs WHERE card_id = ? AND state = 'open' LIMIT 1`

function closableOnMain(db: DatabaseSync, cardId: number): boolean {
  return db.prepare(LIVE_SESSION).get(cardId) === undefined && db.prepare(OPEN_PR_OF_ITS_OWN).get(cardId) === undefined
}

export class WitnessExecutor {
  private readonly serveTurns = new SetupTurns()

  constructor(private readonly parts: WitnessParts) {}

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  async run(lease: Lease): Promise<WitnessOutcome> {
    try {
      assertHeld(this.parts.db, lease)
      const subject = witnessSubjectOf(this.parts.db, lease.cardId)
      if (subject !== null && lease.pr === null && lease.head !== null && isFullSha(lease.head))
        return await this.onMain(lease, subject, lease.head)
      if (subject === null || lease.pr === null || lease.head === null) {
        completeTask(this.parts.db, this.ts(), lease, [])
        return { kind: 'skipped', taskKey: lease.taskKey, why: `card #${lease.cardId} declares no witness with a command, or the task names no pull request head` }
      }
      let base: string
      try {
        const current = await this.parts.trees.baseOf(lease.pr, lease.head)
        base = baseOfKey(lease.taskKey) ?? current
      }
      catch (error) {
        return this.unrun(lease, `the base of ${lease.head} could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
      let judgement: BaseJudgement
      try {
        judgement = await this.judgedOnBase(lease, subject, base, lease.head)
      }
      catch (error) {
        return this.notJudged(lease, subject, base, error)
      }
      if (judgement.kind === 'unfit')
        return this.unfitOutcome(lease, subject, base, judgement)
      const verdict = judgement.kind === 'green' ? GREEN : RED
      const detail = judgement.kind === 'red' ? judgement.detail : `every card witness red on the base ${base} and green on ${lease.head}`
      completeTask(this.parts.db, this.ts(), lease, [this.recorded(lease, subject, base, verdict, detail)])
      return { kind: 'recorded', taskKey: lease.taskKey, verdict, base, detail }
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private async onMain(lease: Lease, subject: WitnessSubject, main: string): Promise<WitnessOutcome> {
    let red: string | null
    try {
      red = await this.redOnMain(lease, subject, main)
    }
    catch (error) {
      return this.notJudged(lease, subject, main, error)
    }
    const verdict = red === null ? GREEN : RED
    const detail = red ?? `every card witness green on main at ${main}`
    const closing = red === null && closableOnMain(this.parts.db, lease.cardId) ? [this.closedOnMain(lease, main)] : []
    completeTask(this.parts.db, this.ts(), lease, [this.recorded(lease, subject, main, verdict, detail), ...closing])
    return { kind: 'recorded', taskKey: lease.taskKey, verdict, base: main, detail }
  }

  private async redOnMain(lease: Lease, subject: WitnessSubject, main: string): Promise<string | null> {
    const last: { result: ShellResult | null } = { result: null }
    const shell = this.budgeted(this.parts.clock().getTime() + WITNESS_BUDGET_MS, last, main, lease)
    return this.parts.trees.withTree(main, async (tree) => {
      if (existsSync(path.join(tree, LOCKFILE)) && (await shell(INSTALL, tree)).status !== 0)
        return withFailureExcerpt(`${INSTALL} failed on main at ${main}`, last.result)
      for (const witness of [...subject.acceptance, ...subject.invariants]) {
        if ((await shell(witness.command, tree)).status !== 0)
          return withFailureExcerpt(`on main: "${witness.criterion}" exits ${last.result?.status ?? 'without a status'} at ${main}`, last.result)
      }
      return null
    })
  }

  private closedOnMain(lease: Lease, main: string): BusEvent {
    return { ts: this.ts(), type: CARD_CLOSED, actor: lease.actor, cardId: lease.cardId, pr: null, head: main, dedupeKey: `${CARD_CLOSED}:${lease.cardId}`, payload: { verification: VERIFIED_BY_RUNNING_WITNESSES, witnessedOnMain: main }, legacy: false }
  }

  private unrun(lease: Lease, detail: string): WitnessOutcome {
    const next = failTask(this.parts.db, this.ts(), lease, { reason: WITNESS_UNRUN, withdraw: false }, this.parts.silentMs)
    return { kind: 'denied', taskKey: lease.taskKey, denial: { kind: 'technical', reason: WITNESS_UNRUN, detail }, next }
  }

  private refusedForNoServe(lease: Lease, detail: string): WitnessOutcome {
    const denied: BusEvent = { ts: this.ts(), type: POLICY_DENIED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${POLICY_DENIED}:${lease.taskKey}:${lease.leaseGen}`, payload: { command: 'witness', reason: WITNESS_NO_SERVE, detail }, legacy: false }
    completeTask(this.parts.db, this.ts(), lease, [denied])
    return { kind: 'skipped', taskKey: lease.taskKey, why: detail }
  }

  private couldNotCheck(lease: Lease, subject: WitnessSubject, base: string, detail: string): WitnessOutcome {
    completeTask(this.parts.db, this.ts(), lease, [this.recorded(lease, subject, base, UNCHECKED, detail)])
    return { kind: 'recorded', taskKey: lease.taskKey, verdict: UNCHECKED, base, detail }
  }

  private notJudged(lease: Lease, subject: WitnessSubject, base: string, error: unknown): WitnessOutcome {
    if (error instanceof WitnessCouldNotCheck)
      return this.couldNotCheck(lease, subject, base, error.message)
    if (error instanceof NoServeDeclared)
      return this.refusedForNoServe(lease, error.message)
    if (error instanceof WitnessNotRun)
      return this.unrun(lease, error.message)
    throw error
  }

  private childStarted(lease: Lease, pid: number, tree: string): boolean {
    try {
      const identity = this.parts.identity?.(pid) ?? null
      return identity !== null && recordChildStarted(this.parts.db, this.ts(), lease.actor, { mode: 'child', ...instanceOf(process.env), ...identity, kind: WITNESS_KIND, taskKey: lease.taskKey, tree })
    }
    catch (error) {
      this.parts.log(`${lease.taskKey}: the start of witness child ${pid} was not recorded: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private childEnded(lease: Lease, pid: number, result: TimedShellResult): void {
    try {
      recordChildEnded(this.parts.db, this.ts(), lease.actor, { instance: instanceOf(process.env).instance, pid, taskKey: lease.taskKey, exit: result.status, signal: result.timedOut ? 'SIGKILL' : null })
    }
    catch (error) {
      this.parts.log(`${lease.taskKey}: the end of witness child ${pid} was not recorded: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private budgeted(deadline: number, last: { result: ShellResult | null }, head: string, lease: Lease): (command: string, cwd: string) => Promise<ShellResult> {
    const leftOf = (command: string): number => {
      const left = deadline - this.parts.clock().getTime()
      if (left <= 0)
        throw new WitnessTimedOut(command)
      return left
    }
    const run = async (command: string, cwd: string): Promise<ShellResult> => {
      let recorded: number | null = null
      const result = await this.parts.shell(command, cwd, leftOf(command), (pid) => {
        recorded = this.childStarted(lease, pid, cwd) ? pid : null
      })
      if (recorded !== null)
        this.childEnded(lease, recorded, result)
      if (result.timedOut)
        throw new WitnessTimedOut(command)
      last.result = result
      return result
    }
    return async (command, cwd) => {
      if (!BROWSER_COMMAND.test(command))
        return run(command, cwd)
      const serve = serveRecordAt(cwd, head)
      if (!needsServer(command, serve))
        return run(command, cwd)
      if (serve === null)
        throw new NoServeDeclared(command, head)
      return this.serveTurns.take(() => this.servedRun(command, cwd, serve, leftOf, run))
    }
  }

  private async servedRun(command: string, cwd: string, serve: ServeRecord, leftOf: (command: string) => number, run: (command: string, cwd: string) => Promise<ShellResult>): Promise<ShellResult> {
    const patienceMs = Math.min(serve.readyTimeoutMs, leftOf(command))
    if (await answers(serve.url))
      throw new ServeAddressTaken(serve.url)
    const server = startServer(serve.command, cwd)
    try {
      const notReady = await notAnswering(server, serve, patienceMs)
      if (notReady === null)
        return await run(command, cwd)
      throw new WitnessCouldNotCheck(`${notReady}, so "${command}" did not run`)
    }
    finally {
      await stopServer(server)
    }
  }

  private async judgedOnBase(lease: Lease, subject: WitnessSubject, base: string, head: string): Promise<BaseJudgement> {
    const deadline = this.parts.clock().getTime() + WITNESS_BUDGET_MS
    const last: { result: ShellResult | null } = { result: null }
    const scope = cardScopeOf(this.parts.db, subject)
    return this.parts.trees.withTree(base, async (tree) => {
      const changed = changedOnHead(tree, base, head)
      const witnesses = [...subject.acceptance, ...subject.invariants]
      const outside = witnesses.flatMap(witness => namedOutsideTheCard(tree, witness, scope, changed).map(file => ({ witness, file })))
      if (outside.length > 0)
        return unfitJudgement(outside.map(({ witness, file }) => `witness "${witness.criterion}" names ${file}, absent on the base ${base} and outside the card's touches, creates and diff: a file another card writes`), outside.map(({ witness }) => witness), witnesses, changed)
      const budgeted = this.budgeted(deadline, last, head, lease)
      const onBase: BaseRun[] = []
      let phase = ''
      const shell = async (command: string, cwd: string): Promise<ShellResult> => {
        const result = await budgeted(command, cwd)
        if (phase === BASE_PHASE)
          onBase.push({ command, output: result.output })
        return result
      }
      let red: string | null = null
      try {
        await runOnTreeAsync(
          { tree, base, shell, phase: (name) => {
            phase = name
          }, log: this.parts.log, refuse: (step, problem) => {
            if (problem !== null)
              throw new WitnessRed(step, problem)
          } },
          { acceptance: subject.acceptance, invariants: subject.invariants, harnessCommand: null, sketchSha: head, changed: [], witnessesDir: tree, creates: subject.creates },
        )
      }
      catch (error) {
        if (!(error instanceof WitnessRed))
          throw error
        red = withFailureExcerpt(error.message, last.result)
      }
      const empty = witnessesFindingNoTest(witnesses, onBase)
      if (empty.length > 0)
        return unfitJudgement(empty.map(witness => `witness "${witness.criterion}" ran no test on the base ${base}: a witness that finds zero tests cannot fail`), empty, witnesses, changed)
      return red === null ? { kind: 'green' } : { kind: 'red', detail: red }
    })
  }

  private unfitOutcome(lease: Lease, subject: WitnessSubject, base: string, judgement: Extract<BaseJudgement, { kind: 'unfit' }>): WitnessOutcome {
    const head = lease.head!
    const proposal = judgement.replacement === null
      ? 'the card\'s diff holds no test file to propose; amend the witness to a test the card adds, red on main'
      : `replace it with ${judgement.replacement.map(field => `--witness ${field.id}=${JSON.stringify(field)}`).join(' ')}`
    const detail = `${judgement.why.join('; ')}; ${proposal}`
    const stopped: BusEvent = { ts: this.ts(), type: CARD_STOPPED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head, dedupeKey: `${CARD_STOPPED}:${WITNESS_UNFIT}:${lease.cardId}:${head}:${base}:${subject.cardBody}`, payload: { reason: QUESTION_AGENT, code: WITNESS_UNFIT, detail, paths: judgement.files }, legacy: false }
    completeTask(this.parts.db, this.ts(), lease, [this.recorded(lease, subject, base, UNFIT, detail), stopped])
    return { kind: 'recorded', taskKey: lease.taskKey, verdict: UNFIT, base, detail, replacement: judgement.replacement }
  }

  private recorded(lease: Lease, subject: WitnessSubject, base: string, verdict: NodeVerdict, detail: string): BusEvent {
    return { ts: this.ts(), type: WITNESS_RECORDED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${WITNESS_RECORDED}:${lease.cardId}:${lease.head}:${base}:${subject.cardBody}`, payload: { head: lease.head, base, cardBody: subject.cardBody, verdict, detail }, legacy: false }
  }
}

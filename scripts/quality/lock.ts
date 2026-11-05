import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { sleep } from '../core/every.js'
import { CLIENT_SANDBOX_DIRECTORY } from '../ports/client/claude/adapter.js'

export const LOCK_DIR_VARIABLE = 'CONSTRUCT_QUALITY_LOCK_DIR'
export const HELD_VARIABLE = 'CONSTRUCT_QUALITY_LOCK_HELD'
export const LOG_FILE = 'lock.log'
const HELD = 'held'
const HOLDER_FILE = 'holder.json'
const POLL_MS = 1000
const PREFIX = '[quality-lock] '
const SESSIONS_DIR = 'sessions'
const SESSION_FILE_SUFFIX = '.json'
const SESSION_NAME_LENGTH = 16

export interface Holder { pid: number, cwd: string, at: string }

interface SessionRecord { tree: string, pid: number }

export interface BudgetDeps {
  dir: string
  tree: string
  pid: number
  cores: number
  isAlive: (pid: number) => boolean
}

export type LockEvent
  = | { event: 'wait', pid: number, cwd: string, at: string, holder: Holder }
    | { event: 'stale', pid: number, cwd: string, at: string, holder: Holder }
    | { event: 'start', pid: number, cwd: string, at: string }
    | { event: 'end', pid: number, cwd: string, at: string, exitCode: number }

export interface LockDeps {
  dir: string
  pid: number
  cwd: string
  now: () => Date
  isAlive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
  say: (line: string) => void
  run: () => Promise<number>
}

function log(dir: string, entry: LockEvent): void {
  appendFileSync(path.join(dir, LOG_FILE), `${JSON.stringify(entry)}\n`)
}

function readHolder(dir: string): Holder | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, HELD, HOLDER_FILE), 'utf8')) as Holder
  }
  catch {
    return undefined
  }
}

function tryTake(dir: string, holder: Holder): boolean {
  const staged = mkdtempSync(path.join(dir, `${HELD}-${holder.pid}-`))
  writeFileSync(path.join(staged, HOLDER_FILE), JSON.stringify(holder))
  try {
    renameSync(staged, path.join(dir, HELD))
    return true
  }
  catch {
    rmSync(staged, { recursive: true, force: true })
    return false
  }
}

function releaseStale(dir: string, holder: Holder): void {
  const parked = path.join(dir, `${HELD}-stale-${holder.pid}`)
  try {
    renameSync(path.join(dir, HELD), parked)
    rmSync(parked, { recursive: true, force: true })
  }
  catch {}
}

export async function withQualityLock(deps: LockDeps): Promise<number> {
  mkdirSync(deps.dir, { recursive: true })
  const at = (): string => deps.now().toISOString()
  const me = { pid: deps.pid, cwd: deps.cwd }
  let waitingOn: number | undefined
  while (!tryTake(deps.dir, { ...me, at: at() })) {
    const holder = readHolder(deps.dir)
    if (holder === undefined) {
      await deps.sleep(POLL_MS)
      continue
    }
    if (!deps.isAlive(holder.pid)) {
      log(deps.dir, { event: 'stale', ...me, at: at(), holder })
      releaseStale(deps.dir, holder)
      continue
    }
    if (waitingOn !== holder.pid) {
      waitingOn = holder.pid
      log(deps.dir, { event: 'wait', ...me, at: at(), holder })
      deps.say(`${PREFIX}waiting for pid ${holder.pid} in ${holder.cwd}, holding since ${holder.at}`)
    }
    await deps.sleep(POLL_MS)
  }
  log(deps.dir, { event: 'start', ...me, at: at() })
  let exitCode = 1
  try {
    exitCode = await deps.run()
  }
  finally {
    log(deps.dir, { event: 'end', ...me, at: at(), exitCode })
    rmSync(path.join(deps.dir, HELD), { recursive: true, force: true })
  }
  return exitCode
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function canWrite(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    rmSync(mkdtempSync(path.join(dir, 'probe-')), { recursive: true, force: true })
    return true
  }
  catch {
    return false
  }
}

export function queueDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const documented = path.join(home, '.construct', 'quality')
  return env[LOCK_DIR_VARIABLE] ?? (canWrite(documented) ? documented : path.join(CLIENT_SANDBOX_DIRECTORY, 'construct-quality'))
}

export function workerBudget(cores: number, sessions: number): number {
  return Math.max(1, Math.floor((cores - 1) / Math.max(1, sessions)))
}

function sessionFile(sessions: string, tree: string, pid: number): string {
  return path.join(sessions, `${createHash('sha256').update(tree).digest('hex').slice(0, SESSION_NAME_LENGTH)}-${pid}${SESSION_FILE_SUFFIX}`)
}

function readSession(file: string): SessionRecord | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SessionRecord
  }
  catch {
    return null
  }
}

function liveSessions(sessions: string, deps: BudgetDeps): number {
  const trees = new Set<string>()
  for (const name of readdirSync(sessions).filter(entry => entry.endsWith(SESSION_FILE_SUFFIX))) {
    const file = path.join(sessions, name)
    const session = readSession(file)
    if (session === null)
      continue
    if (deps.isAlive(session.pid))
      trees.add(session.tree)
    else
      rmSync(file, { force: true })
  }
  return trees.size
}

export function joinSession(deps: BudgetDeps): number {
  try {
    const sessions = path.join(deps.dir, SESSIONS_DIR)
    mkdirSync(sessions, { recursive: true })
    const file = sessionFile(sessions, deps.tree, deps.pid)
    const staged = `${file}.tmp`
    writeFileSync(staged, JSON.stringify({ tree: deps.tree, pid: deps.pid } satisfies SessionRecord))
    renameSync(staged, file)
    return workerBudget(deps.cores, liveSessions(sessions, deps))
  }
  catch {
    return workerBudget(deps.cores, 1)
  }
}

export function sessionWorkers(tree: string): number {
  return joinSession({ dir: queueDir(), tree, pid: process.pid, cores: os.availableParallelism(), isAlive })
}

export function heavyStep(run: () => Promise<number>, dir: string = queueDir()): Promise<number> {
  if (process.env[HELD_VARIABLE] !== undefined)
    return run()
  return withQualityLock({
    dir,
    pid: process.pid,
    cwd: process.cwd(),
    now: () => new Date(),
    isAlive,
    sleep,
    say: line => process.stderr.write(`${line}\n`),
    run,
  })
}

function runCommand(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', env: { ...process.env, [HELD_VARIABLE]: '1' } })
    child.on('error', (error) => {
      process.stderr.write(`${PREFIX}${error.message}\n`)
      resolve(1)
    })
    child.on('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128 + os.constants.signals[signal])))
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  process.exitCode = await heavyStep(() => runCommand(argv))
}

import type { ParkedDepends } from '../ghosts/handoff-check.js'
import type { ClaudeExit, ClaudeRun } from './claude.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { claudeProjectsDir } from '../../src/commands/cost/index.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { DECISION_FORMAT } from '../decisions/decisions.js'
import { decisionsPath, defaultParking, handoffRefusals, parkedDepends } from '../ghosts/handoff-check.js'
import { appendJournalEvent } from '../ghosts/journal.js'
import { runClaude } from './claude.js'
import { CONTINUE_PROMPT, HANDOFF_INVALID, MAX_RESTARTS } from './continuation.js'
import { boundaryLine, transcriptContext } from './operator-boundary.js'
import { GHOST_JOURNAL } from './places.js'

export const PREFIX = '[relaunch] '
export const USAGE = 'usage: pnpm relaunch <handoff.md> [--max N] [--model <id>] | pnpm relaunch --live | pnpm relaunch --boundary <session>'
export const OPERATOR_CLAUDE = 'claude --permission-mode dontAsk'
export const LAUNCH_LINE = 'pnpm ghosts:launch reads its yes from stdin and this session\'s stdin carries nothing a child can read: run it as echo yes | env -u FORCE_COLOR NO_COLOR=1 pnpm ghosts:launch ...'
export const CHAIN_COMMAND = 'pnpm shift:bg <dir> --parking <parking> --chain'
export const WINDOW_BODY_NOTE = 'window took body #N'
export const OPERATOR_ROLE = `[operator] You are the Operator, the window under relaunch; sign every message [operator]: start the who: shift cards as a shift chain with \`${CHAIN_COMMAND}\` and never run pnpm task:start for them; you never take a card body, except a who: window card, whose body you take yourself and journal as ${WINDOW_BODY_NOTE}; the order in the owner's messages is priority, never a dependency; a "not before" exists only as depends in a card, set with construct intake --admit; read the journal and its failed notifications, repair only what stopped (restart the card, correct it with construct intake --admit, answer the session), and at a task boundary past the context threshold write STOP with STATUS: CONTINUE and exit, so relaunch raises the next session from the handoff.`
export function promptFirstLine(handoff: string): string {
  return `${OPERATOR_ROLE} ${CONTINUE_PROMPT}: ${handoff} — write it only with pnpm handoff:write ${handoff} <draft>`
}
export function boundaryCommand(session: string): string {
  return `pnpm relaunch --boundary ${session}`
}
export function relaunchPrompt(handoff: string, decisions: string | null, session: string): string {
  const decisionsLine = decisions === null ? '' : `\n\nOwner decisions live in ${decisions}: append each decision there as the next \`${DECISION_FORMAT}\` line, read the decisions in force with pnpm decisions ${decisions}, and never copy them into the handoff.`
  return `${promptFirstLine(handoff)}${decisionsLine}\n\nThis file is the handoff; replace its STOP section and STATUS line only with pnpm handoff:write ${handoff} <draft>, never by editing it and never in another file.\n\nAt every task boundary run ${boundaryCommand(session)}: on end, write STOP with STATUS: CONTINUE and exit; on next, take the next task.\n\n${LAUNCH_LINE}`
}
export const NO_MODEL = 'no model: pass --model <id>'
export const FACTORY_FILE = 'factory.json'
export const GH_ACCOUNT_KEY = 'ghAccount'
export const GH_TOKEN_VARIABLE = 'GH_TOKEN'

export type OperatorToken = { kind: 'token', token: string } | { kind: 'unset', reason: string } | { kind: 'failed', reason: string }
export const ALREADY_RUNNING = 'already-running'

const STATUS_LINE = /^STATUS:\s*(CONTINUE|OWNER|DONE|STOP)\b/
const SYNTHETIC_MODEL = '<synthetic>'
const PLAIN_SESSION = /^[\w-]{1,128}$/

export type Status = 'CONTINUE' | 'OWNER' | 'DONE' | 'STOP'

export interface RelaunchDeps {
  cwd: string
  home: string
  pid: number
  claude: string
  env: NodeJS.ProcessEnv
  ghToken: (account: string) => string
  journal: string
  projectsDir: string
  read: (file: string) => string
  write: (file: string, text: string) => void
  create: (file: string, text: string) => boolean
  remove: (file: string) => void
  exists: (file: string) => boolean
  parked: () => ParkedDepends
  listDir: (dir: string) => string[]
  modified: (file: string) => number
  now: () => Date
  uuid: () => string
  run: (run: ClaudeRun) => Promise<ClaudeExit>
  alive: (pid: number) => boolean
  out: (line: string) => void
  err: (line: string) => void
}

interface RelaunchArgs {
  handoff: string
  max: number
  model: string | null
}

export interface LiveSession {
  session: string
  pid: number
  n: number
  handoff: string
}

interface JournalLine {
  event?: unknown
  session?: unknown
  pid?: unknown
  n?: unknown
  handoff?: unknown
}

function journalEntries(text: string): JournalLine[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as JournalLine | null
      return entry !== null && typeof entry === 'object' ? [entry] : []
    }
    catch {
      return []
    }
  })
}

export function liveSessions(journal: string, alive: (pid: number) => boolean): LiveSession[] {
  const open = new Map<string, LiveSession>()
  for (const entry of journalEntries(journal)) {
    if (typeof entry.session !== 'string')
      continue
    if (entry.event === 'relaunch-session' && typeof entry.pid === 'number')
      open.set(entry.session, { session: entry.session, pid: entry.pid, n: Number(entry.n), handoff: String(entry.handoff) })
    else if (entry.event === 'relaunch')
      open.delete(entry.session)
  }
  return [...open.values()].filter(session => alive(session.pid))
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function printLive(deps: RelaunchDeps): number {
  const text = deps.exists(deps.journal) ? deps.read(deps.journal) : ''
  const live = liveSessions(text, deps.alive)
  for (const session of live)
    deps.out(`${PREFIX}live: session ${session.n} ${session.session} pid ${session.pid} on ${session.handoff}`)
  if (live.length === 0)
    deps.out(`${PREFIX}live: none in ${deps.journal}`)
  return 0
}

export function statusOf(text: string): Status | null {
  const found = text.split(/\r?\n/).flatMap(line => STATUS_LINE.exec(line)?.[1] ?? [])
  return (found.at(-1) as Status | undefined) ?? null
}

export function expandHome(file: string, home: string): string {
  if (file === '~')
    return home
  return file.startsWith('~/') ? path.join(home, file.slice(2)) : file
}

export function projectDirOf(projectsDir: string, cwd: string): string {
  return path.join(projectsDir, cwd.replaceAll('/', '-'))
}

function modelOfLine(line: string): string | null {
  try {
    const entry = JSON.parse(line) as { model?: unknown, message?: { model?: unknown } } | null
    const model = entry?.model ?? entry?.message?.model
    return typeof model === 'string' && model !== '' && model !== SYNTHETIC_MODEL ? model : null
  }
  catch {
    return null
  }
}

export function transcriptModel(deps: RelaunchDeps): string | null {
  const dir = projectDirOf(deps.projectsDir, deps.cwd)
  const newest = deps.listDir(dir)
    .filter(file => file.endsWith('.jsonl'))
    .map(file => path.join(dir, file))
    .sort((a, b) => deps.modified(b) - deps.modified(a))
    .at(0)
  if (newest === undefined)
    return null
  return deps.read(newest).split('\n').map(modelOfLine).filter(model => model !== null).at(-1) ?? null
}

function sessionTranscript(deps: RelaunchDeps, session: string): string | null {
  return deps.listDir(deps.projectsDir)
    .map(project => path.join(deps.projectsDir, project, `${session}.jsonl`))
    .find(file => deps.exists(file)) ?? null
}

function printBoundary(deps: RelaunchDeps, session: string): number {
  const transcript = sessionTranscript(deps, session)
  const text = transcript === null ? null : readIfPresent(deps, transcript)
  const context = text === null ? null : transcriptContext(text)
  deps.out(`${PREFIX}${boundaryLine(context, transcript ?? path.join(deps.projectsDir, '*', `${session}.jsonl`))}`)
  return 0
}

function parseArgs(args: string[]): RelaunchArgs | null {
  let handoff: string | undefined
  let max = MAX_RESTARTS
  let model: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const value = args[index + 1]
    if (arg === '--max' || arg === '--model') {
      if (value === undefined || value.startsWith('-'))
        return null
      if (arg === '--max') {
        if (!/^[1-9]\d*$/.test(value))
          return null
        max = Number(value)
      }
      else {
        model = value
      }
      index += 1
    }
    else if (arg.startsWith('--') || handoff !== undefined) {
      return null
    }
    else {
      handoff = arg
    }
  }
  return handoff === undefined ? null : { handoff, max, model }
}

function readIfPresent(deps: RelaunchDeps, handoff: string): string | null {
  try {
    return deps.read(handoff)
  }
  catch {
    return null
  }
}

function sessionFailure(exit: ClaudeExit): string | null {
  if (exit.kind === 'unspawnable')
    return `could not start: ${exit.error}`
  if (exit.code !== 0)
    return exit.code === null ? `ended by ${exit.signal ?? 'a signal'}` : `exited ${exit.code}`
  return null
}

function noHandoff(handoff: string): string {
  return `no handoff at ${handoff}`
}

export function lockPath(handoff: string): string {
  return `${handoff}.lock`
}

function liveHolder(deps: RelaunchDeps, file: string): number | null {
  const text = readIfPresent(deps, file)
  if (text === null)
    return null
  const pid = Number(text.trim())
  return Number.isInteger(pid) && pid > 0 && pid !== deps.pid && deps.alive(pid) ? pid : null
}

function takeoverPath(lock: string): string {
  return `${lock}.takeover`
}

function claimLock(deps: RelaunchDeps, lock: string): number | null {
  const own = `${deps.pid}\n`
  const takeover = takeoverPath(lock)
  for (;;) {
    if (deps.create(lock, own))
      return null
    const holder = liveHolder(deps, lock)
    if (holder !== null)
      return holder
    if (!deps.create(takeover, own)) {
      const taker = liveHolder(deps, takeover)
      if (taker !== null)
        return taker
      if (deps.exists(takeover))
        deps.remove(takeover)
      continue
    }
    try {
      const current = liveHolder(deps, lock)
      if (current !== null)
        return current
      deps.write(lock, own)
      return null
    }
    finally {
      deps.remove(takeover)
    }
  }
}

export function createExclusive(file: string, text: string): boolean {
  try {
    writeFileSync(file, text, { flag: 'wx' })
    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return false
    throw error
  }
}

export function factoryPath(home: string): string {
  return path.join(home, '.construct', FACTORY_FILE)
}

function configuredAccount(deps: RelaunchDeps, file: string): string | null {
  const text = readIfPresent(deps, file)
  if (text === null)
    return null
  try {
    const config = JSON.parse(text) as unknown
    const account = config !== null && typeof config === 'object' ? (config as Record<string, unknown>)[GH_ACCOUNT_KEY] : undefined
    return typeof account === 'string' && account.trim() !== '' ? account.trim() : null
  }
  catch {
    return null
  }
}

export function operatorToken(deps: RelaunchDeps): OperatorToken {
  const file = factoryPath(deps.home)
  const account = configuredAccount(deps, file)
  if (account === null)
    return { kind: 'unset', reason: `no ${GH_ACCOUNT_KEY} in ${file}: the Operator keeps this environment's GitHub credentials` }
  try {
    const token = deps.ghToken(account).trim()
    return token === '' ? { kind: 'failed', reason: `gh auth token --user ${account} printed no token` } : { kind: 'token', token }
  }
  catch (error) {
    return { kind: 'failed', reason: `gh auth token --user ${account} failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function ghAccountToken(account: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('gh', ['auth', 'token', '--user', account], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function record(deps: RelaunchDeps, event: object): Promise<void> {
  mkdirSync(path.dirname(deps.journal), { recursive: true })
  await appendJournalEvent(deps.journal, event)
}

export async function runRelaunch(args: string[], deps: RelaunchDeps): Promise<number> {
  if (args.length === 1 && args[0] === '--live')
    return printLive(deps)
  if (args.length === 2 && args[0] === '--boundary' && PLAIN_SESSION.test(args[1]!))
    return printBoundary(deps, args[1]!)
  const parsed = parseArgs(args)
  if (parsed === null) {
    deps.err(`${PREFIX}${USAGE}`)
    return 1
  }
  const handoff = path.resolve(deps.cwd, expandHome(parsed.handoff, deps.home))
  await record(deps, { event: 'relaunch-start', handoff, max: parsed.max, ts: deps.now().toISOString() })
  let sessions = 0
  const stop = async (reason: string, code: number, refusals?: string[]): Promise<number> => {
    await record(deps, { event: 'relaunch-stop', handoff, reason, sessions, ...(refusals === undefined ? {} : { refusals }), ts: deps.now().toISOString() })
    if (code === 0)
      deps.out(`${PREFIX}${reason}`)
    else
      deps.err(`${PREFIX}${reason}`)
    return code
  }
  if (readIfPresent(deps, handoff) === null)
    return stop(noHandoff(handoff), 1)
  const holder = claimLock(deps, lockPath(handoff))
  if (holder !== null)
    return stop(`${ALREADY_RUNNING} ${holder}`, 1)
  const model = parsed.model ?? transcriptModel(deps)
  if (model === null)
    return stop(NO_MODEL, 1)
  const token = operatorToken(deps)
  if (token.kind === 'failed')
    return stop(token.reason, 1)
  if (token.kind === 'unset')
    deps.out(`${PREFIX}${token.reason}`)
  else
    deps.env[GH_TOKEN_VARIABLE] = token.token
  const command = deps.claude
  for (;;) {
    const text = readIfPresent(deps, handoff)
    if (text === null)
      return stop(noHandoff(handoff), 1)
    const refusals = handoffRefusals(text, { file: handoff, home: deps.home, exists: deps.exists, parked: deps.parked() })
    if (refusals.length > 0) {
      for (const line of refusals)
        deps.err(line)
      return stop(HANDOFF_INVALID, 1, refusals)
    }
    const status = statusOf(text)
    if (status === null)
      return stop('no STATUS line', 1)
    if (status !== 'CONTINUE')
      return stop(`STATUS ${status}`, 0)
    if (sessions >= parsed.max)
      return stop(`max ${parsed.max} reached`, 0)
    sessions += 1
    const session = deps.uuid()
    deps.out(`${PREFIX}session ${sessions}/${parsed.max} ${session} on ${model}`)
    let pid: number | null = null
    let started: Promise<void> = Promise.resolve()
    const n = sessions
    const onSpawn = (spawned: number): void => {
      pid = spawned
      started = record(deps, { event: 'relaunch-session', handoff, session, pid: spawned, n, ts: deps.now().toISOString() })
    }
    const exit = await deps.run({ command, cwd: deps.cwd, sessionId: session, prompt: relaunchPrompt(handoff, decisionsPath(text, handoff, deps.home), session), log: `${handoff}.relaunch-${sessions}.log`, extraArgv: ['--model', model], onSpawn })
    await started
    await record(deps, {
      event: 'relaunch',
      handoff,
      session,
      pid,
      model,
      n: sessions,
      exit: exit.kind === 'exited' ? exit.code : null,
      status: statusOf(readIfPresent(deps, handoff) ?? '') ?? 'none',
      ts: deps.now().toISOString(),
    })
    const failure = sessionFailure(exit)
    if (failure !== null)
      return stop(`session ${sessions} ${failure}`, 1)
  }
}

export function realDeps(env: NodeJS.ProcessEnv = process.env): RelaunchDeps {
  return {
    cwd: process.cwd(),
    home: os.homedir(),
    pid: process.pid,
    claude: OPERATOR_CLAUDE,
    env,
    ghToken: account => ghAccountToken(account, env),
    journal: path.join(env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL),
    projectsDir: claudeProjectsDir(),
    read: file => readFileSync(file, 'utf8'),
    write: (file, text) => writeFileSync(file, text),
    create: createExclusive,
    remove: file => rmSync(file, { force: true }),
    exists: existsSync,
    parked: () => parkedDepends(defaultParking(os.homedir())),
    listDir: dir => existsSync(dir) ? readdirSync(dir) : [],
    modified: file => statSync(file).mtimeMs,
    now: () => new Date(),
    uuid: randomUUID,
    run: runClaude,
    alive: pidAlive,
    out: line => console.log(line),
    err: line => console.error(line),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runRelaunch(process.argv.slice(2), realDeps())

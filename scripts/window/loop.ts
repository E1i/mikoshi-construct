import type { DatabaseSync } from 'node:sqlite'
import type { ProcessRow } from './exit.js'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isOwnerCheckout } from '../core/bus-path.js'
import { appendEvent, defaultBusPath, inTransaction, openBus } from '../core/db.js'
import { PROCESS_ENDED, PROCESS_HEARTBEAT, PROCESS_REFUSED } from '../core/events.js'
import { defaultHandoffDir } from '../core/handoff-dir.js'
import { EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE } from '../ports/session.js'
import { recordProcessHeartbeat } from '../supervisor/heartbeat.js'
import { beatsLive, SILENT_MS } from '../supervisor/liveness-sites.js'
import { ancestors, parsePs } from './exit.js'
import { windowEndObserver } from './role-end.js'
import { lastLoopBeats, LOOP_PROCESS } from './window-heartbeat.js'

export const PREFIX = '[miko] '
export const HANDOFF_VARIABLE = 'CONSTRUCT_HANDOFF'
export const CLAUDE_VARIABLE = 'MIKO_CLAUDE'
export const DEFAULT_CLAUDE = 'claude --permission-mode dontAsk'
export const MIKO_HANDOFF_NAME = 'miko.md'
export interface WindowCommands {
  write: string
  watch: string
  exit: string
}

export const OWNER_COMMANDS: WindowCommands = { write: 'pnpm handoff:write', watch: 'pnpm miko:watch --once', exit: 'pnpm miko:exit' }
export const PACKAGE_COMMANDS: WindowCommands = { write: 'miko handoff write', watch: 'miko watch --once', exit: 'miko exit' }

export function continuePrompt(handoff: string, commands: WindowCommands): string {
  return `прочитай ${handoff}; если последняя строка STATUS: в нём — CONTINUE, продолжай с его следующей задачи, не спрашивая владельца; если OWNER — задай вопрос владельцу в окне и жди ответа в этой же сессии, после ответа ${commands.write} со STATUS: CONTINUE, без ${commands.exit}; событие жди через ${commands.watch} в этой же сессии, следующую карточку бери в этой же сессии, ${commands.write} на каждой границе — страховка, без ${commands.exit}; ${commands.exit} — только при контексте или тратах сессии не ниже порога предупреждения Eddies или STATUS: DONE`
}

export const CONTINUE_PROMPT = continuePrompt(`~/.construct/handoff/${MIKO_HANDOFF_NAME}`, OWNER_COMMANDS)

export function repositoryContinuePrompt(dir: string, handoff: string): string {
  return isOwnerCheckout(dir) ? CONTINUE_PROMPT : continuePrompt(handoff, PACKAGE_COMMANDS)
}

export const PAUSE_MS = 3000
export const DOUBLE_CTRL_C_WINDOW_MS = 1500
export const EXIT_REQUEST_PREFIX = 'miko-exit'
export const EXIT_POLL_MS = 200
export const LOOP_BEAT_MS = 5 * 60_000

export type Status = 'CONTINUE' | 'OWNER' | 'DONE' | 'STOP'

const STATUS_LINE = /^STATUS:\s*(CONTINUE|OWNER|DONE|STOP)\b/

export function statusOf(text: string): Status | null {
  const found = text.split(/\r?\n/).flatMap(line => STATUS_LINE.exec(line)?.[1] ?? [])
  return (found.at(-1) as Status | undefined) ?? null
}

const SHELL_COULD_NOT_RUN_THE_COMMAND = new Set([126, 127])

export interface SessionEnd {
  code: number | null
  signal: NodeJS.Signals | null
}

export type PauseEnd = 'elapsed' | 'ctrl-c'

export interface MikoLoopDeps {
  status: () => Status | null | undefined
  handoffMtime: () => number | undefined
  session: (prompt: string | undefined) => Promise<SessionEnd>
  pause: (ms: number) => Promise<PauseEnd>
  doubleCtrlC: () => boolean
  err: (line: string) => void
  ended: () => void
  continuePrompt?: string
}

export function mikoHandoff(handoffDir: string): string {
  return path.join(handoffDir, MIKO_HANDOFF_NAME)
}

export function exitRequestFile(handoffDir: string, loopPid: number): string {
  return path.join(handoffDir, `${EXIT_REQUEST_PREFIX}.${loopPid}.request`)
}

export function takeExitRequest(request: string): boolean {
  if (!existsSync(request))
    return false
  rmSync(request, { force: true })
  return true
}

export function requesterOf(request: string): number | undefined {
  try {
    const pid = Number(readFileSync(request, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  }
  catch {
    return undefined
  }
}

export function requestEndsSession(table: ProcessRow[] | null, requester: number | undefined, sessionPid: number | undefined): boolean {
  if (table === null || requester === undefined || sessionPid === undefined)
    return true
  return requester === sessionPid || ancestors(table, requester).some(row => row.pid === sessionPid)
}

function readTable(): ProcessRow[] | null {
  try {
    return parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' }))
  }
  catch {
    return null
  }
}

export interface LiveLoop {
  process: string
  lastBeat: string
}

export function loopProcess(pid: number): string {
  return `${LOOP_PROCESS}${pid}`
}

function loopActor(pid: number): string {
  return `worker:miko:${pid}`
}

export function liveLoop(db: DatabaseSync, pid: number, nowMs: number): LiveLoop | null {
  const own = loopProcess(pid)
  const live = lastLoopBeats(db).find(beat => beat.name !== own && beatsLive(beat.ts, nowMs))
  return live === undefined ? null : { process: live.name, lastBeat: live.ts }
}

export function claimLoop(db: DatabaseSync, pid: number, now: Date): string | null {
  const ts = now.toISOString()
  const own = loopProcess(pid)
  return inTransaction(db, () => {
    const live = liveLoop(db, pid, now.getTime())
    if (live === null) {
      recordProcessHeartbeat(db, ts, own)
      return null
    }
    appendEvent(db, { ts, type: PROCESS_REFUSED, actor: loopActor(pid), cardId: null, pr: null, head: null, dedupeKey: `${PROCESS_REFUSED}:${own}:${ts}`, payload: { process: own, live: live.process, last_beat: live.lastBeat }, legacy: false })
    return `${PREFIX}another pnpm miko loop is alive as ${live.process} (last heartbeat ${live.lastBeat}, within ${SILENT_MS / 60_000} min): ${PROCESS_REFUSED}, this one starts no session`
  })
}

export function recordLoopEnded(db: DatabaseSync, pid: number, now: Date): void {
  const ts = now.toISOString()
  const own = loopProcess(pid)
  appendEvent(db, { ts, type: PROCESS_ENDED, actor: loopActor(pid), cardId: null, pr: null, head: null, dedupeKey: `${PROCESS_ENDED}:${own}:${ts}`, payload: { process: own }, legacy: false })
}

export interface LoopInstance {
  claim: () => string | null
  beat: () => void
  end: () => void
}

export function loopInstance(busPath: string, pid: number, now: () => Date, err: (line: string) => void): LoopInstance {
  const onBus = (what: string, work: (db: DatabaseSync) => void): void => {
    try {
      const db = openBus(busPath)
      try {
        work(db)
      }
      finally {
        db.close()
      }
    }
    catch (error) {
      err(`${PREFIX}${what} not written to ${busPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    claim: () => {
      let refusal: string | null = null
      onBus('the start heartbeat', (db) => {
        refusal = claimLoop(db, pid, now())
      })
      return refusal
    },
    beat: () => onBus(PROCESS_HEARTBEAT, db => recordProcessHeartbeat(db, now().toISOString(), loopProcess(pid))),
    end: () => onBus(PROCESS_ENDED, db => recordLoopEnded(db, pid, now())),
  }
}

const SHELL_SYNTAX = /[;&|()<>`\n]/

export function sessionScript(command: string): string {
  return SHELL_SYNTAX.test(command) ? `${command} "$@"` : `exec env ${command} "$@"`
}

export function compoundCommandRefusal(command: string): string | null {
  return SHELL_SYNTAX.test(command) ? `${PREFIX}${CLAUDE_VARIABLE} contains shell syntax (${command}): an exit request could not end the claude it starts; name one command` : null
}

export function claudeArgv(command: string, prompt: string | undefined): string[] {
  return ['-c', sessionScript(command), 'miko', ...(prompt === undefined ? [] : [prompt])]
}

export function doubleCtrlCWatcher(now: () => number = Date.now): { press: () => void, seen: () => boolean, presses: () => number } {
  let last = Number.NEGATIVE_INFINITY
  let seen = false
  let presses = 0
  return {
    press: () => {
      const at = now()
      seen ||= at - last <= DOUBLE_CTRL_C_WINDOW_MS
      last = at
      presses++
    },
    seen: () => seen,
    presses: () => presses,
  }
}

export function sessionCtrlCsStillInFlight(end: SessionEnd, pressesSeenDuringSession: number): number {
  return end.signal === 'SIGINT' && pressesSeenDuringSession === 0 ? 1 : 0
}

export function sessionAndPauseSharingCtrlCs(
  ctrlC: { presses: () => number },
  runSession: (prompt: string | undefined) => Promise<SessionEnd>,
): Pick<MikoLoopDeps, 'session' | 'pause'> {
  let sessionCtrlCs = 0
  return {
    session: async (prompt) => {
      const pressesBefore = ctrlC.presses()
      const end = await runSession(prompt)
      sessionCtrlCs = sessionCtrlCsStillInFlight(end, ctrlC.presses() - pressesBefore)
      return end
    },
    pause: ms => pauseUntilCtrlC(ms, sessionCtrlCs),
  }
}

function didNotStart(end: SessionEnd): boolean {
  return (end.code === null && end.signal === null) || SHELL_COULD_NOT_RUN_THE_COMMAND.has(end.code ?? -1)
}

export async function runMikoLoop(deps: MikoLoopDeps): Promise<number> {
  const code = await sessionsUntilTheWindowEnds(deps)
  deps.ended()
  return code
}

async function sessionsUntilTheWindowEnds(deps: MikoLoopDeps): Promise<number> {
  const next = deps.continuePrompt ?? CONTINUE_PROMPT
  let prompt = deps.status() === undefined ? undefined : next
  for (;;) {
    const before = deps.handoffMtime()
    const end = await deps.session(prompt)
    if (deps.doubleCtrlC()) {
      deps.err(`${PREFIX}double Ctrl+C during the session: no next session`)
      return 0
    }
    if (didNotStart(end)) {
      deps.err(`${PREFIX}the session did not start: no next session`)
      return 1
    }
    if (deps.handoffMtime() === before) {
      deps.err(`${PREFIX}the session ended without rewriting ${MIKO_HANDOFF_NAME}: no next session`)
      return 0
    }
    const status = deps.status()
    if (status !== 'CONTINUE') {
      deps.err(`${PREFIX}${MIKO_HANDOFF_NAME} says STATUS: ${status ?? 'none'}: no next session`)
      return 0
    }
    deps.err(`${PREFIX}STATUS: CONTINUE: next session in ${PAUSE_MS / 1000}s, Ctrl+C now stops the loop`)
    if (await deps.pause(PAUSE_MS) === 'ctrl-c') {
      deps.err(`${PREFIX}Ctrl+C in the pause: no next session`)
      return 0
    }
    prompt = next
  }
}

function statusOfFile(file: string): Status | null | undefined {
  return existsSync(file) ? statusOf(readFileSync(file, 'utf8')) : undefined
}

function mtimeOf(file: string): number | undefined {
  return existsSync(file) ? statSync(file).mtimeMs : undefined
}

export async function pauseUntilCtrlC(ms: number, sessionCtrlCs = 0): Promise<PauseEnd> {
  const ctrlC = new AbortController()
  let unclaimedSessionCtrlCs = sessionCtrlCs
  const abort = (): void => {
    if (unclaimedSessionCtrlCs > 0)
      unclaimedSessionCtrlCs--
    else
      ctrlC.abort()
  }
  process.on('SIGINT', abort)
  try {
    await sleep(ms, undefined, { signal: ctrlC.signal })
    return 'elapsed'
  }
  catch {
    return 'ctrl-c'
  }
  finally {
    process.off('SIGINT', abort)
  }
}

export function runSession(command: string, prompt: string | undefined, request: string, pollMs: number = EXIT_POLL_MS): Promise<SessionEnd> {
  return new Promise((resolve) => {
    rmSync(request, { force: true })
    const child = spawn('sh', claudeArgv(command, prompt), { stdio: 'inherit', env: { ...process.env, [LOOP_PID_VARIABLE]: String(process.pid), [WINDOW_VARIABLE]: WINDOW_MARK, [EXIT_REQUEST_VARIABLE]: request } })
    const watcher = setInterval(() => {
      const requester = requesterOf(request)
      if (!takeExitRequest(request))
        return
      if (requestEndsSession(readTable(), requester, child.pid))
        child.kill('SIGTERM')
      else
        console.error(`${PREFIX}an exit request from pid ${requester} does not come from the session this loop started: ignored`)
    }, pollMs)
    child.on('error', () => {
      clearInterval(watcher)
      resolve({ code: null, signal: null })
    })
    child.on('close', (code, signal) => {
      clearInterval(watcher)
      resolve({ code, signal })
    })
  })
}

export const HANGUPS = ['SIGHUP', 'SIGTERM'] as const

export function once(work: () => void): () => void {
  let done = false
  return () => {
    if (done)
      return
    done = true
    work()
  }
}

export function endOnHangup(ended: () => void, exit: (code: number) => void): void {
  for (const signal of HANGUPS) {
    process.on(signal, () => {
      ended()
      exit(128 + os.constants.signals[signal])
    })
  }
}

export function claudeCommand(env: NodeJS.ProcessEnv): string {
  return env[CLAUDE_VARIABLE] ?? DEFAULT_CLAUDE
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = claudeCommand(process.env)
  const refusal = compoundCommandRefusal(command)
  if (refusal !== null) {
    console.error(refusal)
    process.exit(1)
  }
  const instance = loopInstance(defaultBusPath(), process.pid, () => new Date(), line => console.error(line))
  const refused = instance.claim()
  if (refused !== null) {
    console.error(refused)
    process.exit(1)
  }
  const beating = setInterval(instance.beat, LOOP_BEAT_MS)
  beating.unref()
  const ctrlC = doubleCtrlCWatcher()
  process.on('SIGINT', ctrlC.press)
  const handoffDir = defaultHandoffDir()
  mkdirSync(handoffDir, { recursive: true })
  const handoff = mikoHandoff(handoffDir)
  const request = exitRequestFile(handoffDir, process.pid)
  const ended = once(() => {
    clearInterval(beating)
    instance.end()
    windowEndObserver({ busPath: defaultBusPath(), pid: process.pid, now: () => new Date(), err: line => console.error(`${PREFIX}${line}`) })('close')
  })
  endOnHangup(ended, code => process.exit(code))
  try {
    process.exitCode = await runMikoLoop({
      status: () => statusOfFile(handoff),
      handoffMtime: () => mtimeOf(handoff),
      ...sessionAndPauseSharingCtrlCs(ctrlC, prompt => runSession(command, prompt, request)),
      doubleCtrlC: ctrlC.seen,
      err: line => console.error(line),
      ended,
      continuePrompt: repositoryContinuePrompt(process.cwd(), handoff),
    })
  }
  finally {
    rmSync(request, { force: true })
  }
}

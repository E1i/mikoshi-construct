import type { Status } from '../shift/relaunch.js'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { statusOf } from '../shift/relaunch.js'

export const PREFIX = '[miko] '
export const CLAUDE_VARIABLE = 'MIKO_CLAUDE'
export const DEFAULT_CLAUDE = 'claude --permission-mode auto'
export const CONTINUE_PROMPT = 'прочитай mikoshi.md'
export const PAUSE_MS = 3000
export const DOUBLE_CTRL_C_MS = 2000

const SHELL_COULD_NOT_RUN_THE_COMMAND = new Set([126, 127])

export interface SessionEnd {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface MikoLoopDeps {
  status: () => Status | null | undefined
  handoffMtime: () => number | undefined
  session: (prompt: string | undefined) => Promise<SessionEnd>
  pause: (ms: number) => Promise<void>
  doubleCtrlC: () => boolean
  err: (line: string) => void
}

export function mikoshiHandoff(home: string): string {
  return path.join(home, '.construct', 'handoff', 'mikoshi.md')
}

export function claudeArgv(command: string, prompt: string | undefined): string[] {
  return ['-c', `${command} "$@"`, 'miko', ...(prompt === undefined ? [] : [prompt])]
}

export function isDoubleCtrlC(presses: number[], windowMs = DOUBLE_CTRL_C_MS): boolean {
  return presses.some((at, index) => index > 0 && at - presses[index - 1]! <= windowMs)
}

function didNotStart(end: SessionEnd): boolean {
  return (end.code === null && end.signal === null) || SHELL_COULD_NOT_RUN_THE_COMMAND.has(end.code ?? -1)
}

export async function runMikoLoop(deps: MikoLoopDeps): Promise<number> {
  let prompt = deps.status() === undefined ? undefined : CONTINUE_PROMPT
  for (;;) {
    const before = deps.handoffMtime()
    const end = await deps.session(prompt)
    if (deps.doubleCtrlC()) {
      deps.err(`${PREFIX}double Ctrl+C: no next session`)
      return 0
    }
    if (didNotStart(end)) {
      deps.err(`${PREFIX}the session did not start: no next session`)
      return 1
    }
    if (deps.handoffMtime() === before) {
      deps.err(`${PREFIX}the session ended without rewriting mikoshi.md: no next session`)
      return 0
    }
    const status = deps.status()
    if (status !== 'CONTINUE') {
      deps.err(`${PREFIX}mikoshi.md says STATUS: ${status ?? 'none'}: no next session`)
      return 0
    }
    deps.err(`${PREFIX}STATUS: CONTINUE: next session in ${PAUSE_MS / 1000}s, double Ctrl+C stops the loop`)
    await deps.pause(PAUSE_MS)
    if (deps.doubleCtrlC()) {
      deps.err(`${PREFIX}double Ctrl+C: no next session`)
      return 0
    }
    prompt = CONTINUE_PROMPT
  }
}

function statusOfFile(file: string): Status | null | undefined {
  return existsSync(file) ? statusOf(readFileSync(file, 'utf8')) : undefined
}

function mtimeOf(file: string): number | undefined {
  return existsSync(file) ? statSync(file).mtimeMs : undefined
}

function runSession(command: string, prompt: string | undefined): Promise<SessionEnd> {
  return new Promise((resolve) => {
    const child = spawn('sh', claudeArgv(command, prompt), { stdio: 'inherit' })
    child.on('error', () => resolve({ code: null, signal: null }))
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const presses: number[] = []
  process.on('SIGINT', () => {
    presses.push(Date.now())
  })
  const handoff = mikoshiHandoff(os.homedir())
  const command = process.env[CLAUDE_VARIABLE] ?? DEFAULT_CLAUDE
  process.exitCode = await runMikoLoop({
    status: () => statusOfFile(handoff),
    handoffMtime: () => mtimeOf(handoff),
    session: prompt => runSession(command, prompt),
    pause: async ms => sleep(ms),
    doubleCtrlC: () => isDoubleCtrlC(presses),
    err: line => console.error(line),
  })
}

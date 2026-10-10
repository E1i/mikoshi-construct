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
  err: (line: string) => void
}

export function mikoshiHandoff(home: string): string {
  return path.join(home, '.construct', 'handoff', 'mikoshi.md')
}

export function claudeArgv(command: string, prompt: string | undefined): string[] {
  return ['-c', `${command} "$@"`, 'miko', ...(prompt === undefined ? [] : [prompt])]
}

function didNotStart(end: SessionEnd): boolean {
  return (end.code === null && end.signal === null) || SHELL_COULD_NOT_RUN_THE_COMMAND.has(end.code ?? -1)
}

export async function runMikoLoop(deps: MikoLoopDeps): Promise<number> {
  let prompt = deps.status() === undefined ? undefined : CONTINUE_PROMPT
  for (;;) {
    const before = deps.handoffMtime()
    const end = await deps.session(prompt)
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
    deps.err(`${PREFIX}STATUS: CONTINUE: next session in ${PAUSE_MS / 1000}s, Ctrl+C now stops the loop`)
    if (await deps.pause(PAUSE_MS) === 'ctrl-c') {
      deps.err(`${PREFIX}Ctrl+C in the pause: no next session`)
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

async function pauseUntilCtrlC(ms: number): Promise<PauseEnd> {
  const ctrlC = new AbortController()
  const abort = (): void => ctrlC.abort()
  process.once('SIGINT', abort)
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

function runSession(command: string, prompt: string | undefined): Promise<SessionEnd> {
  return new Promise((resolve) => {
    const child = spawn('sh', claudeArgv(command, prompt), { stdio: 'inherit' })
    child.on('error', () => resolve({ code: null, signal: null }))
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('SIGINT', () => {})
  const handoff = mikoshiHandoff(os.homedir())
  const command = process.env[CLAUDE_VARIABLE] ?? DEFAULT_CLAUDE
  process.exitCode = await runMikoLoop({
    status: () => statusOfFile(handoff),
    handoffMtime: () => mtimeOf(handoff),
    session: prompt => runSession(command, prompt),
    pause: pauseUntilCtrlC,
    err: line => console.error(line),
  })
}

import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const PREFIX = '[miko] '
export const CLAUDE_VARIABLE = 'MIKO_CLAUDE'
export const DEFAULT_CLAUDE = 'claude --permission-mode auto'
export const CONTINUE_PROMPT = 'прочитай mikoshi.md'

const SIGINT_EXIT_CODE = 130

export interface SessionEnd {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface MikoLoopDeps {
  handoffMtime: () => number | undefined
  session: (prompt: string | undefined) => Promise<SessionEnd>
  interrupted: () => boolean
  err: (line: string) => void
}

export function mikoshiHandoff(home: string): string {
  return path.join(home, '.construct', 'handoff', 'mikoshi.md')
}

export function claudeArgv(command: string, prompt: string | undefined): string[] {
  return ['-c', `${command} "$@"`, 'miko', ...(prompt === undefined ? [] : [prompt])]
}

export function endedByCtrlC(end: SessionEnd): boolean {
  return end.signal === 'SIGINT' || end.code === SIGINT_EXIT_CODE
}

export async function runMikoLoop(deps: MikoLoopDeps): Promise<number> {
  let prompt: string | undefined
  for (;;) {
    const before = deps.handoffMtime()
    const end = await deps.session(prompt)
    if (endedByCtrlC(end) || deps.interrupted()) {
      deps.err(`${PREFIX}Ctrl+C: no next session`)
      return 0
    }
    const after = deps.handoffMtime()
    if (after === undefined || after === before) {
      deps.err(`${PREFIX}the session ended without writing mikoshi.md: no next session`)
      return 0
    }
    deps.err(`${PREFIX}mikoshi.md written: next session`)
    prompt = CONTINUE_PROMPT
  }
}

function mtimeOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs
  }
  catch {
    return undefined
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
  let interrupted = false
  process.on('SIGINT', () => {
    interrupted = true
  })
  const handoff = mikoshiHandoff(os.homedir())
  const command = process.env[CLAUDE_VARIABLE] ?? DEFAULT_CLAUDE
  process.exitCode = await runMikoLoop({
    handoffMtime: () => mtimeOf(handoff),
    session: prompt => runSession(command, prompt),
    interrupted: () => interrupted,
    err: line => console.error(line),
  })
}

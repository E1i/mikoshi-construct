import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import process from 'node:process'

export const HEADLESS_FLAGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'auto',
  '--permission-prompts',
  'none',
  '--session-id',
] as const

export function sessionArgv(sessionId: string, prompt: string): string[] {
  return [...HEADLESS_FLAGS, sessionId, prompt]
}

export function sessionEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }
}

export interface SpawnSessionParams {
  cwd: string
  sessionId: string
  prompt: string
  stdoutPath: string
  stderrPath: string
  env?: NodeJS.ProcessEnv
}

export function spawnSession(params: SpawnSessionParams): Promise<number> {
  const outFd = openSync(params.stdoutPath, 'w')
  const errFd = openSync(params.stderrPath, 'w')

  return new Promise((resolve, reject) => {
    const child = spawn('claude', sessionArgv(params.sessionId, params.prompt), {
      cwd: params.cwd,
      env: sessionEnv(params.env),
      stdio: ['ignore', outFd, errFd],
    })

    child.on('error', (error) => {
      closeSync(outFd)
      closeSync(errFd)
      reject(error)
    })

    child.on('close', (code) => {
      closeSync(outFd)
      closeSync(errFd)
      resolve(code ?? 1)
    })
  })
}

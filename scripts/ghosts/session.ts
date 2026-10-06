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
  '--strict-mcp-config',
  '--session-id',
] as const

export function sessionArgv(sessionId: string, prompt: string): string[] {
  return [...HEADLESS_FLAGS, sessionId, prompt]
}

export const CARD_VARIABLE = 'CONSTRUCT_CARD'

export function sessionEnv(base: NodeJS.ProcessEnv = process.env, card?: number): NodeJS.ProcessEnv {
  const env = { ...base, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }
  return card === undefined ? env : { ...env, [CARD_VARIABLE]: String(card) }
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
  let closed = false
  const closeOnce = (): void => {
    if (!closed) {
      closed = true
      closeSync(outFd)
      closeSync(errFd)
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn('claude', sessionArgv(params.sessionId, params.prompt), {
      cwd: params.cwd,
      env: sessionEnv(params.env),
      stdio: ['ignore', outFd, errFd],
    })

    child.on('error', (error) => {
      closeOnce()
      reject(error)
    })

    child.on('close', (code) => {
      closeOnce()
      resolve(code ?? 1)
    })
  })
}

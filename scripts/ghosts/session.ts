import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import process from 'node:process'

export const REVIEW_PERMISSION_MODE = 'auto'

export const HEADLESS_FLAGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  REVIEW_PERMISSION_MODE,
  '--permission-prompts',
  'none',
  '--strict-mcp-config',
  '--session-id',
] as const

export function sessionArgv(sessionId: string, prompt: string, addDirs: string[] = [], model?: string): string[] {
  const modelFlag = model === undefined ? [] : ['--model', model]
  return [...addDirs.flatMap(dir => ['--add-dir', dir]), ...modelFlag, ...HEADLESS_FLAGS, sessionId, prompt]
}

export const REVIEW_MODEL_VARIABLE = 'CONSTRUCT_REVIEW_MODEL'

export function reviewModelOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const model = env[REVIEW_MODEL_VARIABLE]?.trim()
  return model === undefined || model === '' ? undefined : model
}

function initModelOf(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as { type?: unknown, subtype?: unknown, model?: unknown }
    return event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string' ? event.model : undefined
  }
  catch {
    return undefined
  }
}

export function sessionModelOf(streamJson: string): string | undefined {
  for (const line of streamJson.split('\n')) {
    const model = initModelOf(line)
    if (model !== undefined)
      return model
  }
  return undefined
}

export const CARD_VARIABLE = 'CONSTRUCT_CARD'

export function witnessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { FORCE_COLOR: _forced, CLICOLOR_FORCE: _clicolorForced, ...rest } = base
  return { ...rest, NO_COLOR: '1' }
}

export function sessionEnv(base: NodeJS.ProcessEnv = process.env, card?: number): NodeJS.ProcessEnv {
  const env = { ...witnessEnv(base), CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }
  return card === undefined ? env : { ...env, [CARD_VARIABLE]: String(card) }
}

export interface SpawnSessionParams {
  cwd: string
  sessionId: string
  prompt: string
  stdoutPath: string
  stderrPath: string
  env?: NodeJS.ProcessEnv
  addDirs?: string[]
  model?: string
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
    const child = spawn('claude', sessionArgv(params.sessionId, params.prompt, params.addDirs, params.model), {
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

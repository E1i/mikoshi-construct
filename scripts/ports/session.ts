import type { Invocation, Role, SessionPolicy, SessionSpec } from './client/contract.js'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import process from 'node:process'
import { BUS_DB_VARIABLE } from '../core/bus-path.js'
import { clientAdapter } from './client/index.js'

export function clientInvocation(spec: SessionSpec): Invocation {
  const invocation = clientAdapter().invocation(spec)
  if ('kind' in invocation)
    throw new Error(invocation.reason)
  return invocation
}

const HEADLESS_POLICY: SessionPolicy = { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: true }

const ANY_HEADLESS_SESSION: SessionSpec = { kind: 'start', role: 'ghost', session: '', cwd: '', prompt: '', addDirs: [], pick: { model: null }, policy: HEADLESS_POLICY }

export function clientCommand(): string {
  return clientInvocation(ANY_HEADLESS_SESSION).command
}

export function clientIsolationCommand(): string[] {
  return clientAdapter().processes.isolationCommand()
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
export const WINDOW_VARIABLE = 'MIKO_WINDOW'
export const WINDOW_MARK = '1'
export const LOOP_PID_VARIABLE = 'MIKO_LOOP_PID'
export const EXIT_REQUEST_VARIABLE = 'MIKO_EXIT_REQUEST'

export type WindowMode = 'loop' | 'tab'

function underTheLoop(env: NodeJS.ProcessEnv): boolean {
  return env[WINDOW_VARIABLE] === WINDOW_MARK || Boolean(env[LOOP_PID_VARIABLE]) || Boolean(env[EXIT_REQUEST_VARIABLE])
}

export function windowModeOf(env: NodeJS.ProcessEnv): WindowMode | null {
  if (env[CARD_VARIABLE])
    return null
  return underTheLoop(env) ? 'loop' : 'tab'
}

export function witnessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { FORCE_COLOR: _forced, CLICOLOR_FORCE: _clicolorForced, ...rest } = base
  return { ...rest, NO_COLOR: '1' }
}

export function withoutCard(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [CARD_VARIABLE]: _card, [WINDOW_VARIABLE]: _window, ...rest } = base
  return rest
}

export function sessionEnv(base: NodeJS.ProcessEnv = process.env, card?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...witnessEnv(base), ...clientInvocation(ANY_HEADLESS_SESSION).env }
  if (card === undefined)
    return env
  const { [BUS_DB_VARIABLE]: _ownersBus, ...cardEnv } = env
  return { ...cardEnv, [CARD_VARIABLE]: String(card) }
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
  ceilingMs?: number
  role?: Extract<Role, 'review' | 'ghost'>
}

export class SessionCeilingReached extends Error {
  constructor(readonly sessionId: string, readonly ceilingMs: number) {
    super(`the session ${sessionId} ran past its ceiling of ${ceilingMs / 60_000} minutes and was ended`)
  }
}

export function spawnSession(params: SpawnSessionParams): Promise<number> {
  const invocation = clientInvocation({ ...ANY_HEADLESS_SESSION, role: params.role ?? ANY_HEADLESS_SESSION.role, session: params.sessionId, cwd: params.cwd, prompt: params.prompt, addDirs: params.addDirs ?? [], pick: { model: params.model ?? null } })
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
    const child = spawn(invocation.command, invocation.args, {
      cwd: params.cwd,
      env: { ...sessionEnv(params.env), ...invocation.env },
      stdio: ['ignore', outFd, errFd],
      ...(params.ceilingMs === undefined ? {} : { timeout: params.ceilingMs, killSignal: 'SIGKILL' as const }),
    })
    const started = Date.now()

    child.on('error', (error) => {
      closeOnce()
      reject(error)
    })

    child.on('exit', (_code, signal) => {
      if (params.ceilingMs !== undefined && signal === 'SIGKILL' && Date.now() - started >= params.ceilingMs) {
        closeOnce()
        reject(new SessionCeilingReached(params.sessionId, params.ceilingMs))
      }
    })

    child.on('close', (code) => {
      closeOnce()
      resolve(code ?? 1)
    })
  })
}

export function spawnReviewSession(params: SpawnSessionParams): Promise<number> {
  return spawnSession({ ...params, role: 'review' })
}

import type { Invocation, Role, SessionPolicy, SessionReading, SessionSpec } from './client/contract.js'
import { spawn } from 'node:child_process'
import { closeSync, openSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { BUS_DB_VARIABLE } from '../core/bus-path.js'
import { CLIENT_ENV_PREFIXES, compactWindowOverlay } from './client/claude/adapter.js'
import { clientAdapter } from './client/index.js'
import { PREPARE_ENV_KEYS } from './prepare-tree.js'

export const TECHNOLOGY_WORDS = ['argv', 'spawn', 'stderr', 'stdout'] as const

export function clientInvocation(spec: SessionSpec): Invocation {
  const invocation = clientAdapter().invocation(spec)
  if ('kind' in invocation)
    throw new Error(invocation.reason)
  return invocation
}

const HEADLESS_POLICY: SessionPolicy = { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: true }

const ANY_HEADLESS_SESSION: SessionSpec = { kind: 'start', role: 'ghost', session: '', cwd: '', prompt: '', addDirs: [], pick: { model: null }, policy: HEADLESS_POLICY }

export function headlessInvocation(parts: Partial<SessionSpec> = {}): Invocation {
  return clientInvocation({ ...ANY_HEADLESS_SESSION, ...parts })
}

export function clientCommand(): string {
  return headlessInvocation().command
}

export function streamReading(stdoutPath: string): SessionReading {
  return clientAdapter().reading({ session: '', cwd: '', stdoutPath, stderrPath: null, exitCode: null })
}

export const REVIEW_MODEL_VARIABLE = 'CONSTRUCT_REVIEW_MODEL'

export function reviewModelOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const model = env[REVIEW_MODEL_VARIABLE]?.trim()
  return model === undefined || model === '' ? undefined : model
}

export const CARD_VARIABLE = 'CONSTRUCT_CARD'
export const CARD_SIZE_VARIABLE = 'CONSTRUCT_CARD_SIZE'
export const WINDOW_VARIABLE = 'MIKO_WINDOW'
export const WINDOW_MARK = '1'
export const LOOP_PID_VARIABLE = 'MIKO_LOOP_PID'
export const EXIT_REQUEST_VARIABLE = 'MIKO_EXIT_REQUEST'

export type WindowMode = 'loop' | 'tab'

const TAB_LAUNCHER_MARK: WindowMode = 'tab'

function underTheLoop(env: NodeJS.ProcessEnv): boolean {
  return env[WINDOW_VARIABLE] === WINDOW_MARK || Boolean(env[LOOP_PID_VARIABLE]) || Boolean(env[EXIT_REQUEST_VARIABLE])
}

export function windowModeOf(env: NodeJS.ProcessEnv): WindowMode | null {
  if (env[CARD_VARIABLE])
    return null
  if (underTheLoop(env))
    return 'loop'
  return env[WINDOW_VARIABLE] === TAB_LAUNCHER_MARK ? TAB_LAUNCHER_MARK : null
}

export function witnessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { FORCE_COLOR: _forced, CLICOLOR_FORCE: _clicolorForced, ...rest } = base
  return { ...rest, NO_COLOR: '1' }
}

export function withoutCard(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [CARD_VARIABLE]: _card, [CARD_SIZE_VARIABLE]: _size, [WINDOW_VARIABLE]: _window, ...rest } = base
  return rest
}

const SESSION_ENV_NAMES: ReadonlySet<string> = new Set([...PREPARE_ENV_KEYS, 'USER', 'LOGNAME', 'SHELL', 'TERM', 'GH_TOKEN', 'NODE_EXTRA_CA_CERTS'])
const OWN_ENV_PREFIXES = ['CONSTRUCT_', 'LC_']

function isSessionVariable(name: string): boolean {
  return SESSION_ENV_NAMES.has(name) || [...OWN_ENV_PREFIXES, ...CLIENT_ENV_PREFIXES].some(prefix => name.startsWith(prefix))
}

function listedVariables(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([name]) => isSessionVariable(name)))
}

const BODY_CARD_PREFIX = 'card: '
const SIZE_OF_CARD_LINE = /^#\d+ \S+ \[[^/\]]+\/[^/\]]+\/([^/\]]+)\//

export function cardSizeIn(cardBody: string | null): string | null {
  if (cardBody === null)
    return null
  const first = cardBody.split('\n')[0]!.trim()
  const line = first.startsWith(BODY_CARD_PREFIX) ? first.slice(BODY_CARD_PREFIX.length) : first
  return SIZE_OF_CARD_LINE.exec(line)?.[1] ?? null
}

export function cardSessionOverlay(root: string, base: NodeJS.ProcessEnv, size: string | null): NodeJS.ProcessEnv {
  return { ...(size === null ? {} : { [CARD_SIZE_VARIABLE]: size }), ...compactWindowOverlay(root, base, size) }
}

export function sessionEnv(base: NodeJS.ProcessEnv = process.env, card?: number, cardOverlay: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...witnessEnv(listedVariables(base)), ...headlessInvocation().env }
  if (card === undefined)
    return env
  const { [BUS_DB_VARIABLE]: _ownersBus, [CARD_SIZE_VARIABLE]: _inheritedSize, ...cardEnv } = env
  return { ...cardEnv, [CARD_VARIABLE]: String(card), ...cardOverlay }
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
  started?: (pid: number) => void
}

export class SessionCeilingReached extends Error {
  constructor(readonly sessionId: string, readonly ceilingMs: number) {
    super(`the session ${sessionId} ran past its ceiling of ${ceilingMs / 60_000} minutes and was ended`)
  }
}

export function spawnSession(params: SpawnSessionParams): Promise<number> {
  const invocation = headlessInvocation({ role: params.role ?? ANY_HEADLESS_SESSION.role, session: params.sessionId, cwd: params.cwd, prompt: params.prompt, addDirs: params.addDirs ?? [], pick: { model: params.model ?? null } })
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
    if (child.pid !== undefined)
      params.started?.(child.pid)
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

export type SessionSpawner = (params: SpawnSessionParams) => Promise<number>

export interface SessionRun {
  code: number
  stdout?: string
  stderr?: string
}

export type SessionAnswer = SessionRun | Error

export class InMemorySessions {
  readonly started: SpawnSessionParams[] = []

  constructor(private readonly answer: (params: SpawnSessionParams) => SessionAnswer) {}

  readonly spawn: SessionSpawner = async (params) => {
    this.started.push(params)
    const answered = this.answer(params)
    if (answered instanceof Error)
      throw answered
    writeFileSync(params.stdoutPath, answered.stdout ?? '')
    writeFileSync(params.stderrPath, answered.stderr ?? '')
    return answered.code
  }

  readonly spawnReview: SessionSpawner = async params => this.spawn({ ...params, role: 'review' })
}

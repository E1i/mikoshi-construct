import type { TranscriptCounters as Counters } from '../ports/client/claude/adapter.js'
import type { StopReason } from './exit.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { openDatabase } from '../core/sqlite.js'
import { findTranscript, measuredSession, measuredSpent, spendBasis, transcriptContext, transcriptCounters, transcriptModel } from '../ports/client/claude/adapter.js'
import { CARD_VARIABLE } from '../ports/session.js'

export const UNKNOWN = 'unknown'
export const SESSION_EXIT_EVENT = 'session-exit'
const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
export const PROJECT_VARIABLE = 'CLAUDE_PROJECT_DIR'
export const LOADED_CORE_VARIABLE = 'MIKO_LOADED_CORE'
const CORE_FILE = path.join('architecture', 'window-core.md')
const CORE_VERSION_LINE = /^window-core v(\d+)$/m
const CONFIG_FILE = path.join('.claude', 'eddies.json')
const EDDIES_JOURNAL_FILE = path.join('.construct', 'eddies.jsonl')
const JOURNAL_VERSION = 1
const PLAIN_ID = /^[\w-]{1,128}$/
const REPO_ROOT = path.join(import.meta.dirname, '..', '..')

type Unknown = typeof UNKNOWN
export type Reading<T> = T | Unknown

export const GAUGES_UNREAD = 'unread'
export const NO_TRANSCRIPT = 'no-transcript'

export interface SessionGauges {
  context?: number
  spent?: number
  model?: string
  reason?: typeof GAUGES_UNREAD | typeof NO_TRANSCRIPT
  error?: string
}

export interface ExitReadings {
  sessionId: Reading<string>
  start: Reading<Counters>
  end: Reading<Counters>
  context: Reading<number>
  contextWarn: Reading<number>
  spent: Reading<number>
  spendWarn: Reading<number>
  cards: Reading<number>
  busEvents: Reading<number>
  coreLoaded: Reading<number>
  coreOnMain: Reading<number>
}

export interface ExitLine {
  v: number
  event: typeof SESSION_EXIT_EVENT
  session_id: Reading<string>
  start: Reading<Counters>
  end: Reading<Counters>
  spent: Reading<number>
  measurement_basis: string
  reason: StopReason
  cards: Reading<number>
  bus_events: Reading<number>
  at: string
}

export const UNREAD: ExitReadings = { sessionId: UNKNOWN, start: UNKNOWN, end: UNKNOWN, context: UNKNOWN, contextWarn: UNKNOWN, spent: UNKNOWN, spendWarn: UNKNOWN, cards: UNKNOWN, busEvents: UNKNOWN, coreLoaded: UNKNOWN, coreOnMain: UNKNOWN }

export function exitLineOf(readings: ExitReadings, reason: StopReason, at: string): ExitLine {
  return {
    v: JOURNAL_VERSION,
    event: SESSION_EXIT_EVENT,
    session_id: readings.sessionId,
    start: readings.start,
    end: readings.end,
    spent: readings.spent,
    measurement_basis: spendBasis(),
    reason,
    cards: readings.cards,
    bus_events: readings.busEvents,
    at,
  }
}

function attempt<T>(read: () => T | null | undefined): Reading<T> {
  try {
    return read() ?? UNKNOWN
  }
  catch {
    return UNKNOWN
  }
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function foundTranscriptOf(home: string, session: string): string | null {
  return PLAIN_ID.test(session) && existsSync(path.join(home, '.claude', 'projects')) ? findTranscript(home, session) : null
}

export function sessionGauges(home: string, root: string, session: string): SessionGauges {
  try {
    const transcript = foundTranscriptOf(home, session)
    if (transcript === null)
      return { reason: NO_TRANSCRIPT }
    const measured = measuredSession(root, transcript)
    const model = transcriptModel(readFileSync(transcript, 'utf8'))
    return { ...measured, ...(model === null ? {} : { model }) }
  }
  catch (error) {
    return { reason: GAUGES_UNREAD, error: error instanceof Error ? error.message.split('\n')[0]! : String(error) }
  }
}

function warnOf(limit: number | null, warnRatio: number | null): Reading<number> {
  return limit === null || warnRatio === null || warnRatio > 1 ? UNKNOWN : limit * warnRatio
}

function cardLineOf(config: Record<string, unknown>, env: NodeJS.ProcessEnv): number | null {
  return env[CARD_VARIABLE] ? positive(config.cardContextLine) : null
}

function limitsOf(root: string, env: NodeJS.ProcessEnv): { contextWarn: Reading<number>, spendWarn: Reading<number> } {
  const config = attempt(() => JSON.parse(readFileSync(path.join(root, CONFIG_FILE), 'utf8')) as Record<string, unknown> | null)
  if (config === UNKNOWN || typeof config !== 'object')
    return { contextWarn: UNKNOWN, spendWarn: UNKNOWN }
  const warnRatio = positive(config.warnRatio)
  return {
    contextWarn: cardLineOf(config, env) ?? warnOf(positive(config.contextLimit), warnRatio),
    spendWarn: warnOf(positive(config.sessionSpend), warnRatio),
  }
}

export function coreVersionIn(root: string): Reading<number> {
  return attempt(() => positive(Number(CORE_VERSION_LINE.exec(readFileSync(path.join(root, CORE_FILE), 'utf8'))?.[1])))
}

function coreReadings(env: NodeJS.ProcessEnv, root: string): { coreLoaded: Reading<number>, coreOnMain: Reading<number> } {
  return { coreLoaded: attempt(() => positive(Number(env[LOADED_CORE_VARIABLE]))), coreOnMain: coreVersionIn(root) }
}

function busSince(busPath: string, startedAt: string): { cards: number, busEvents: number } | null {
  if (!existsSync(busPath))
    return null
  const db = openDatabase(busPath, { readOnly: true })
  try {
    const row = db.prepare('SELECT count(*) AS events, count(DISTINCT card_id) AS cards FROM events WHERE ts >= ?').get(startedAt) as { events: number, cards: number }
    return { cards: Number(row.cards), busEvents: Number(row.events) }
  }
  finally {
    db.close()
  }
}

export function realExitReadings(env: NodeJS.ProcessEnv, home: string, root: string, busPath: string): ExitReadings {
  const limits = { ...limitsOf(root, env), ...coreReadings(env, root) }
  const session = env[SESSION_VARIABLE]
  if (session === undefined || !PLAIN_ID.test(session))
    return { ...UNREAD, ...limits }
  const transcript = attempt(() => findTranscript(home, session))
  if (transcript === UNKNOWN)
    return { ...UNREAD, ...limits, sessionId: session }
  const text = attempt(() => readFileSync(transcript, 'utf8'))
  const counters = text === UNKNOWN ? { start: null, end: null, startedAt: null } : transcriptCounters(text)
  const startedAt = counters.startedAt
  const bus = startedAt === null ? UNKNOWN : attempt(() => busSince(busPath, startedAt))
  return {
    sessionId: session,
    start: counters.start ?? UNKNOWN,
    end: counters.end ?? UNKNOWN,
    context: text === UNKNOWN ? UNKNOWN : transcriptContext(text) ?? UNKNOWN,
    spent: attempt(() => measuredSpent(root, transcript)),
    ...limits,
    cards: bus === UNKNOWN ? UNKNOWN : bus.cards,
    busEvents: bus === UNKNOWN ? UNKNOWN : bus.busEvents,
  }
}

export function projectRoot(env: NodeJS.ProcessEnv): string {
  const root = env[PROJECT_VARIABLE]
  return root !== undefined && root !== '' ? root : REPO_ROOT
}

export function appendExitLine(root: string, line: ExitLine): void {
  mkdirSync(path.join(root, '.construct'), { recursive: true })
  appendFileSync(path.join(root, EDDIES_JOURNAL_FILE), `${JSON.stringify(line)}\n`)
}

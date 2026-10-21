import type { StopReason } from './exit.js'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { openDatabase } from '../bus/sqlite.js'
import { transcriptContext } from '../shift/operator-boundary.js'

export const UNKNOWN = 'unknown'
export const SESSION_EXIT_EVENT = 'session-exit'
const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const PROJECT_VARIABLE = 'CLAUDE_PROJECT_DIR'
const CONFIG_FILE = path.join('.claude', 'eddies.json')
const EDDIES_JOURNAL_FILE = path.join('.construct', 'eddies.jsonl')
const JOURNAL_VERSION = 1
const PLAIN_ID = /^[\w-]{1,128}$/
const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const HOOK_MEASURE_MODULE = path.join(REPO_ROOT, '.claude', 'hooks', 'eddies-measure.mjs')

interface Tokens {
  input: number
  cacheWrite: number
  cacheRead: number
}

interface HookMeasure {
  SPEND_BASIS: string
  addTokens: (into: Tokens, tokens: Tokens) => Tokens
  spentOf: (tokens: Tokens) => number
  contextOf: (tokens: Tokens) => number
  readTranscript: (root: string, transcript: string) => { tokens: Tokens, last: Tokens }
  sumTranscripts: (root: string, files: string[]) => Tokens
  agentTranscriptsUnder: (dir: string) => string[]
}

const hookMeasure = createRequire(import.meta.url)(HOOK_MEASURE_MODULE) as HookMeasure

type Unknown = typeof UNKNOWN
export type Reading<T> = T | Unknown

export interface Counters {
  input: number
  cache_write: number
  cache_read: number
}

export const GAUGES_UNREAD = 'unread'
export const NO_TRANSCRIPT = 'no-transcript'

export interface SessionGauges {
  context?: number
  spent?: number
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

export const UNREAD: ExitReadings = { sessionId: UNKNOWN, start: UNKNOWN, end: UNKNOWN, context: UNKNOWN, contextWarn: UNKNOWN, spent: UNKNOWN, spendWarn: UNKNOWN, cards: UNKNOWN, busEvents: UNKNOWN }

export function exitLineOf(readings: ExitReadings, reason: StopReason, at: string): ExitLine {
  return {
    v: JOURNAL_VERSION,
    event: SESSION_EXIT_EVENT,
    session_id: readings.sessionId,
    start: readings.start,
    end: readings.end,
    spent: readings.spent,
    measurement_basis: hookMeasure.SPEND_BASIS,
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

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

interface TranscriptEntry {
  timestamp?: unknown
  message?: { role?: unknown, usage?: { input_tokens?: unknown, cache_creation_input_tokens?: unknown, cache_read_input_tokens?: unknown } | null }
}

function entriesOf(text: string): TranscriptEntry[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as unknown
      return entry !== null && typeof entry === 'object' ? [entry as TranscriptEntry] : []
    }
    catch {
      return []
    }
  })
}

function countersOf(entry: TranscriptEntry): Counters | null {
  const usage = entry.message?.role === 'assistant' ? entry.message.usage : null
  if (usage == null || typeof usage !== 'object')
    return null
  return { input: count(usage.input_tokens), cache_write: count(usage.cache_creation_input_tokens), cache_read: count(usage.cache_read_input_tokens) }
}

export function sessionCounters(text: string): { start: Counters | null, end: Counters | null, startedAt: string | null } {
  const entries = entriesOf(text)
  const counters = entries.map(countersOf).filter(counter => counter !== null)
  const startedAt = entries.map(entry => entry.timestamp).find(stamp => typeof stamp === 'string') as string | undefined
  return { start: counters.at(0) ?? null, end: counters.at(-1) ?? null, startedAt: startedAt ?? null }
}

function transcriptOf(home: string, session: string): string | null {
  const projects = path.join(home, '.claude', 'projects')
  return readdirSync(projects).map(project => path.join(projects, project, `${session}.jsonl`)).find(existsSync) ?? null
}

function foundTranscriptOf(home: string, session: string): string | null {
  return PLAIN_ID.test(session) && existsSync(path.join(home, '.claude', 'projects')) ? transcriptOf(home, session) : null
}

function spentWithAgents(root: string, transcript: string, parent: Tokens): number {
  const agents = hookMeasure.sumTranscripts(root, hookMeasure.agentTranscriptsUnder(path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')))
  return hookMeasure.spentOf(hookMeasure.addTokens({ ...parent }, agents))
}

function sessionSpent(root: string, transcript: string): number {
  return spentWithAgents(root, transcript, hookMeasure.readTranscript(root, transcript).tokens)
}

export function sessionGauges(home: string, root: string, session: string): SessionGauges {
  try {
    const transcript = foundTranscriptOf(home, session)
    if (transcript === null)
      return { reason: NO_TRANSCRIPT }
    const parent = hookMeasure.readTranscript(root, transcript)
    return { context: hookMeasure.contextOf(parent.last), spent: spentWithAgents(root, transcript, parent.tokens) }
  }
  catch (error) {
    return { reason: GAUGES_UNREAD, error: error instanceof Error ? error.message.split('\n')[0]! : String(error) }
  }
}

function warnOf(limit: number | null, warnRatio: number | null): Reading<number> {
  return limit === null || warnRatio === null || warnRatio > 1 ? UNKNOWN : limit * warnRatio
}

function limitsOf(root: string): { contextWarn: Reading<number>, spendWarn: Reading<number> } {
  const config = attempt(() => JSON.parse(readFileSync(path.join(root, CONFIG_FILE), 'utf8')) as Record<string, unknown> | null)
  if (config === UNKNOWN || typeof config !== 'object')
    return { contextWarn: UNKNOWN, spendWarn: UNKNOWN }
  const warnRatio = positive(config.warnRatio)
  return {
    contextWarn: warnOf(positive(config.contextLimit), warnRatio),
    spendWarn: warnOf(positive(config.sessionSpend), warnRatio),
  }
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
  const limits = limitsOf(root)
  const session = env[SESSION_VARIABLE]
  if (session === undefined || !PLAIN_ID.test(session))
    return { ...UNREAD, ...limits }
  const transcript = attempt(() => transcriptOf(home, session))
  if (transcript === UNKNOWN)
    return { ...UNREAD, ...limits, sessionId: session }
  const text = attempt(() => readFileSync(transcript, 'utf8'))
  const counters = text === UNKNOWN ? { start: null, end: null, startedAt: null } : sessionCounters(text)
  const startedAt = counters.startedAt
  const bus = startedAt === null ? UNKNOWN : attempt(() => busSince(busPath, startedAt))
  return {
    sessionId: session,
    start: counters.start ?? UNKNOWN,
    end: counters.end ?? UNKNOWN,
    context: text === UNKNOWN ? UNKNOWN : transcriptContext(text) ?? UNKNOWN,
    spent: attempt(() => sessionSpent(root, transcript)),
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

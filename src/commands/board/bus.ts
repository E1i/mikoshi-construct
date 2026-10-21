import type { BusDb } from '../cost/bus.js'
import { existsSync } from 'node:fs'
import { withReadOnlyBus } from '../cost/bus.js'

export const WINDOW_SUBAGENT_EVENT = 'window.subagent'
export const SESSION_HEARTBEAT_EVENT = 'session.heartbeat'
export const CARD_VERIFIED_EVENT = 'card.verified'
const CARD_STOPPED_EVENT = 'card.stopped'
export const SESSION_DEATH_KEY = `${CARD_STOPPED_EVENT}:session-end:`
const CARD_FELL_EVENT = 'card.fell'
export const CHECKS_MATRIX_EVENT = 'checks.matrix'
export const SHORT_SHA = 7
export const SUBAGENT_SHOWN_HOURS = 12
export const SESSION_SHOWN_MINUTES = 20
export const FLOW_STATES = [['queued'], ['running', 'changes'], ['in_review'], ['ready']]
export const LIVE_STATES = FLOW_STATES.flat()
export const BUS_PULSE_EVENT = 'netwatch.tick'
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

export interface BusCard {
  id: number
  state: string | null
  lane: string | null
  line: string | null
  since: string | null
  body: boolean
  closed: boolean
  closedAt: string | null
}

export interface BusService {
  role: string
  task: string
  tree: string | null
  step: string
}

export interface BusMatrix {
  pr: number
  head: string | null
  full: string | null
  killed: number
  survived: number
  notRun: number
}

export interface BusSlot {
  queue: string
  used: number
}

export interface BusFacts {
  at: string
  pulse: string | null
  slots: BusSlot[]
  cards: BusCard[]
  services: BusService[]
  matrices: BusMatrix[]
  failure: string | null
  reviewQueue: number
}

export type BusReading
  = | { status: 'read', file: string, facts: BusFacts }
    | { status: 'absent', file: string }
    | { status: 'unreadable', file: string, reason: string }

export type BusReader = () => BusReading

interface TaskRow {
  queue: string
  card_id: number
  head: string | null
  verdict: string | null
}

interface EventRow {
  id: number
  ts: string | null
  type: string
  card_id: number | null
  pr: number | null
  dedupe_key: string | null
  legacy: number
  payload: string
}

interface CardRow {
  id: number
  state: string | null
  pr: number | null
  lane: string | null
  line: string | null
  since: string | null
  body: number
}

interface RoleRow {
  role: string
  status: string
  state: string
}

function payloadOf(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function stepOf(row: TaskRow): string {
  if (row.queue === 'review')
    return `review ${row.verdict ?? 'pending'}`
  return row.head === null ? row.queue : `${row.queue} ${row.head.slice(0, SHORT_SHA)}`
}

function taskServices(db: BusDb): BusService[] {
  const rows = db.prepare(`
    SELECT tasks.queue, tasks.card_id, tasks.head, prs.verdict_on_head AS verdict
    FROM tasks LEFT JOIN prs ON prs.pr = tasks.pr
    WHERE tasks.state = 'leased'
    ORDER BY tasks.id
  `).all() as unknown as TaskRow[]
  return rows.map(row => ({ role: row.queue, task: `#${row.card_id}`, tree: null, step: stepOf(row) }))
}

function isSilent(row: EventRow, now: Date): boolean {
  const at = row.ts === null ? Number.NaN : Date.parse(row.ts)
  return Number.isNaN(at) || now.getTime() - at > SUBAGENT_SHOWN_HOURS * HOUR_MS
}

function windowRoles(db: BusDb): BusService[] {
  const rows = db.prepare('SELECT role, status, state FROM roles ORDER BY role').all() as unknown as RoleRow[]
  return rows.map(row => ({ role: 'window', task: row.role, tree: null, step: `${row.state} · ${row.status}` }))
}

const BOARD_EVENT_TYPES = [WINDOW_SUBAGENT_EVENT, SESSION_HEARTBEAT_EVENT, CARD_FELL_EVENT, CARD_STOPPED_EVENT, CARD_VERIFIED_EVENT]

interface BoardEvents {
  of: (type: string) => EventRow[]
}

function boardEvents(db: BusDb): BoardEvents {
  const rows = db.prepare(`SELECT id, ts, type, card_id, pr, dedupe_key, legacy, payload FROM events WHERE type IN (${BOARD_EVENT_TYPES.map(() => '?').join(', ')}) ORDER BY id`).all(...BOARD_EVENT_TYPES) as unknown as EventRow[]
  return { of: type => rows.filter(row => row.type === type) }
}

function windowServices(events: BoardEvents, now: Date): BusService[] {
  const running = new Map<string, BusService>()
  for (const row of events.of(WINDOW_SUBAGENT_EVENT)) {
    const payload = payloadOf(row.payload)
    const role = text(payload.role) ?? 'agent'
    const task = text(payload.task) ?? '—'
    const session = text(payload.session) ?? `${role}:${task}`
    if (payload.phase === 'ended' || isSilent(row, now))
      running.delete(session)
    else
      running.set(session, { role, task, tree: text(payload.tree), step: text(payload.step) ?? 'started' })
  }
  return [...running.values()]
}

interface MatrixRow {
  pr: number
  head: string | null
  payload: string
}

function checkMatrices(db: BusDb): BusMatrix[] {
  const rows = db.prepare('SELECT pr, head, payload FROM events WHERE type = ? AND pr IS NOT NULL ORDER BY id').all(CHECKS_MATRIX_EVENT) as unknown as MatrixRow[]
  const latest = new Map<number, BusMatrix>()
  for (const row of rows) {
    const payload = payloadOf(row.payload)
    latest.set(row.pr, { pr: row.pr, head: row.head, full: text(payload.full), killed: count(payload.killed), survived: count(payload.survived), notRun: count(payload.notRun) })
  }
  return [...latest.values()].sort((a, b) => a.pr - b.pr)
}

function minutesAgo(ts: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(ts)) / MINUTE_MS))
}

function sessionServices(events: BoardEvents, now: Date): BusService[] {
  const latest = new Map<string, BusService>()
  for (const row of events.of(SESSION_HEARTBEAT_EVENT)) {
    if (row.ts === null || now.getTime() - Date.parse(row.ts) > SESSION_SHOWN_MINUTES * MINUTE_MS)
      continue
    const payload = payloadOf(row.payload)
    const task = `#${row.card_id ?? '?'}`
    const step = text(payload.step) ?? 'session'
    latest.set(text(payload.session) ?? task, { role: step.split(' ')[0]!, task, tree: null, step: `${step} · pulse ${minutesAgo(row.ts, now)} min ago` })
  }
  return [...latest.values()]
}

function isFailure(row: EventRow): boolean {
  return row.type === CARD_FELL_EVENT || (row.dedupe_key ?? '').startsWith(SESSION_DEATH_KEY)
}

function lastFailure(events: BoardEvents): string | null {
  const row = [...events.of(CARD_FELL_EVENT), ...events.of(CARD_STOPPED_EVENT)].filter(isFailure).sort((a, b) => b.id - a.id)[0]
  if (row === undefined)
    return null
  const what = row.type === CARD_FELL_EVENT ? 'fell' : 'lost its session'
  return `card #${row.card_id ?? '?'} ${what}${row.ts === null ? '' : ` at ${row.ts}`}`
}

function cardsOf(db: BusDb, events: BoardEvents): BusCard[] {
  const rows = db.prepare(`
    SELECT c.card_id AS id, c.state, c.pr, b.lane, b.card_line AS line, e.ts AS since, b.card_id IS NOT NULL AS body
    FROM cards c LEFT JOIN card_bodies b ON b.card_id = c.card_id LEFT JOIN events e ON e.id = c.event_id
    ORDER BY c.card_id
  `).all() as unknown as CardRow[]
  const closed = new Map(events.of(CARD_VERIFIED_EVENT).filter(row => row.legacy === 0).map(row => [row.card_id, row.ts] as const))
  return rows.map(row => ({ id: row.id, state: row.state, lane: row.lane, line: row.line, since: row.since, body: Boolean(row.body), closed: closed.has(row.id), closedAt: closed.get(row.id) ?? null }))
}

function lastPulse(db: BusDb): string | null {
  const row = db.prepare('SELECT ts FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(BUS_PULSE_EVENT) as { ts: string | null } | undefined
  return row?.ts ?? null
}

function slotsInUse(db: BusDb): BusSlot[] {
  return db.prepare(`SELECT queue, count(*) AS used FROM tasks WHERE state = 'leased' GROUP BY queue ORDER BY queue`).all() as unknown as BusSlot[]
}

export function busFacts(db: BusDb, now: Date): BusFacts {
  const queue = db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'review' AND state IN ('queued', 'leased')`).get() as { n: number }
  const events = boardEvents(db)
  return {
    at: now.toISOString(),
    pulse: lastPulse(db),
    slots: slotsInUse(db),
    cards: cardsOf(db, events),
    services: [...windowRoles(db), ...taskServices(db), ...windowServices(events, now), ...sessionServices(events, now)],
    matrices: checkMatrices(db),
    failure: lastFailure(events),
    reviewQueue: Number(queue.n),
  }
}

export function busReaderAt(file: string, clock: () => Date = () => new Date()): BusReader {
  return () => {
    if (!existsSync(file))
      return { status: 'absent', file }
    try {
      return { status: 'read', file, facts: withReadOnlyBus(file, db => busFacts(db, clock())) }
    }
    catch (error) {
      return { status: 'unreadable', file, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

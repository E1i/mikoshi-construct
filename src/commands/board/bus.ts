import type { BusDb } from '../cost/bus.js'
import { existsSync } from 'node:fs'
import { withReadOnlyBus } from '../cost/bus.js'

export const WINDOW_SUBAGENT_EVENT = 'window.subagent'
const CARD_FELL_EVENT = 'card.fell'
export const CHECKS_MATRIX_EVENT = 'checks.matrix'
export const SHORT_SHA = 7
export const SUBAGENT_SHOWN_HOURS = 12
const HOUR_MS = 3_600_000

export interface BusCard {
  id: number
  state: string | null
  lane: string | null
  line: string | null
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

export interface BusFacts {
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
  ts: string | null
  payload: string
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

function windowServices(db: BusDb, now: Date): BusService[] {
  const rows = db.prepare('SELECT ts, payload FROM events WHERE type = ? ORDER BY id').all(WINDOW_SUBAGENT_EVENT) as unknown as EventRow[]
  const running = new Map<string, BusService>()
  for (const row of rows) {
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

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
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

function lastFailure(db: BusDb): string | null {
  const row = db.prepare('SELECT card_id, ts FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(CARD_FELL_EVENT) as { card_id: number | null, ts: string | null } | undefined
  return row === undefined ? null : `card #${row.card_id ?? '?'} fell${row.ts === null ? '' : ` at ${row.ts}`}`
}

function factsOf(db: BusDb, now: Date): BusFacts {
  const cards = db.prepare('SELECT c.card_id AS id, c.state, b.lane, b.card_line AS line FROM cards c LEFT JOIN card_bodies b ON b.card_id = c.card_id ORDER BY c.card_id').all() as unknown as BusCard[]
  const queue = db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'review' AND state IN ('queued', 'leased')`).get() as { n: number }
  return { cards, services: [...taskServices(db), ...windowServices(db, now)], matrices: checkMatrices(db), failure: lastFailure(db), reviewQueue: Number(queue.n) }
}

export function busReaderAt(file: string, clock: () => Date = () => new Date()): BusReader {
  return () => {
    if (!existsSync(file))
      return { status: 'absent', file }
    try {
      return { status: 'read', file, facts: withReadOnlyBus(file, db => factsOf(db, clock())) }
    }
    catch (error) {
      return { status: 'unreadable', file, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

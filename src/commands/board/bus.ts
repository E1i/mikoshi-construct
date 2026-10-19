import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export const WINDOW_SUBAGENT_EVENT = 'window.subagent'
const CARD_FELL_EVENT = 'card.fell'
const SHORT_SHA = 7

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

export interface BusFacts {
  cards: BusCard[]
  services: BusService[]
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

function taskServices(db: DatabaseSync): BusService[] {
  const rows = db.prepare(`
    SELECT tasks.queue, tasks.card_id, tasks.head, prs.verdict_on_head AS verdict
    FROM tasks LEFT JOIN prs ON prs.pr = tasks.pr
    WHERE tasks.state = 'leased'
    ORDER BY tasks.id
  `).all() as unknown as TaskRow[]
  return rows.map(row => ({ role: row.queue, task: `#${row.card_id}`, tree: null, step: stepOf(row) }))
}

function windowServices(db: DatabaseSync): BusService[] {
  const rows = db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(WINDOW_SUBAGENT_EVENT) as unknown as EventRow[]
  const running = new Map<string, BusService>()
  for (const row of rows) {
    const payload = payloadOf(row.payload)
    const role = text(payload.role) ?? 'agent'
    const task = text(payload.task) ?? '—'
    const session = text(payload.session) ?? `${role}:${task}`
    if (payload.phase === 'ended')
      running.delete(session)
    else
      running.set(session, { role, task, tree: text(payload.tree), step: text(payload.step) ?? 'started' })
  }
  return [...running.values()]
}

function lastFailure(db: DatabaseSync): string | null {
  const row = db.prepare('SELECT card_id, ts FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(CARD_FELL_EVENT) as { card_id: number | null, ts: string | null } | undefined
  return row === undefined ? null : `card #${row.card_id ?? '?'} fell${row.ts === null ? '' : ` at ${row.ts}`}`
}

function factsOf(db: DatabaseSync): BusFacts {
  const cards = db.prepare('SELECT c.card_id AS id, c.state, b.lane, b.card_line AS line FROM cards c LEFT JOIN card_bodies b ON b.card_id = c.card_id ORDER BY c.card_id').all() as unknown as BusCard[]
  const queue = db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'review' AND state IN ('queued', 'leased')`).get() as { n: number }
  return { cards, services: [...taskServices(db), ...windowServices(db)], failure: lastFailure(db), reviewQueue: Number(queue.n) }
}

export function busReaderAt(file: string): BusReader {
  return () => {
    if (!existsSync(file))
      return { status: 'absent', file }
    try {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        return { status: 'read', file, facts: factsOf(db) }
      }
      finally {
        db.close()
      }
    }
    catch (error) {
      return { status: 'unreadable', file, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

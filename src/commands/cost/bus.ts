import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { CARD_STARTED } from '../../../scripts/core/events.js'
import { parseCard } from '../../card/grammar.js'
import { projectKey } from './claude-code.js'

const CHEAP_CONTOUR = 'cheap'
const MS_PER_MINUTE = 60_000

interface BusSession {
  id: string
  project: string
}

interface BusTask {
  task: string
  taskClass: string
  sessions: BusSession[]
  minutes: number
}

interface ClosedCardRow {
  card_id: number
  card_line: string | null
  ended: string
  close_payload: string
}

interface SpendRow {
  card_id: number
  type: string
  ts: string
  payload: string
}

const CLOSED_CARDS = `
SELECT c.card_id, b.card_line, k.ts AS ended, k.payload AS close_payload
FROM cards c
JOIN card_bodies b ON b.card_id = c.card_id
JOIN events k ON k.card_id = c.card_id AND k.type = 'card.closed'
WHERE k.ts IS NOT NULL
ORDER BY c.card_id
`

const SPEND_EVENTS = `
SELECT card_id, type, ts, payload
FROM events
WHERE legacy = 0 AND type IN ('card.started', 'card.answered') AND card_id IS NOT NULL AND ts IS NOT NULL
ORDER BY id
`

const LEGACY_LINES = `
SELECT payload FROM events
WHERE legacy = 1
ORDER BY id
`

function payloadOf(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function sessionsOf(spend: readonly SpendRow[]): BusSession[] {
  const sessions = new Map<string, BusSession>()
  let worktree: string | undefined
  for (const row of spend) {
    const payload = payloadOf(row.payload)
    if (row.type === CARD_STARTED && typeof payload.worktree === 'string')
      worktree = payload.worktree
    const tree = typeof payload.worktree === 'string' ? payload.worktree : worktree
    if (typeof payload.session === 'string' && payload.session !== '' && tree !== undefined && !sessions.has(payload.session))
      sessions.set(payload.session, { id: payload.session, project: projectKey(tree) })
  }
  return [...sessions.values()]
}

function taskOf(row: ClosedCardRow, spend: readonly SpendRow[]): BusTask | null {
  if (row.card_line === null)
    return null
  const parsed = parseCard(row.card_line)
  if (parsed.kind !== 'card' || parsed.card.contour !== CHEAP_CONTOUR)
    return null
  if (typeof payloadOf(row.close_payload).verification !== 'string')
    return null
  const started = spend.find(event => event.type === CARD_STARTED)
  const sessions = sessionsOf(spend)
  if (started === undefined || sessions.length === 0)
    return null
  const minutes = (Date.parse(row.ended) - Date.parse(started.ts)) / MS_PER_MINUTE
  if (!Number.isFinite(minutes) || minutes < 0)
    return null
  return {
    task: String(row.card_id),
    taskClass: `${parsed.card.kind}/${parsed.card.size}`,
    sessions,
    minutes,
  }
}

function spendByCard(rows: readonly SpendRow[]): Map<number, SpendRow[]> {
  const byCard = new Map<number, SpendRow[]>()
  for (const row of rows)
    byCard.set(row.card_id, [...byCard.get(row.card_id) ?? [], row])
  return byCard
}

export function readBusTasks(busPath: string): BusTask[] {
  if (!existsSync(busPath))
    return []
  try {
    return withReadOnlyBus(busPath, (db) => {
      const spend = spendByCard(db.prepare(SPEND_EVENTS).all() as unknown as SpendRow[])
      return (db.prepare(CLOSED_CARDS).all() as unknown as ClosedCardRow[]).flatMap((row) => {
        const task = taskOf(row, spend.get(row.card_id) ?? [])
        return task === null ? [] : [task]
      })
    })
  }
  catch {
    return []
  }
}

export function readLegacyLines<Line>(busPath: string): Line[] {
  if (!existsSync(busPath))
    return []
  try {
    return withReadOnlyBus(busPath, db => (db.prepare(LEGACY_LINES).all() as { payload: string }[]).flatMap((row) => {
      const payload = payloadOf(row.payload)
      return Object.keys(payload).length === 0 ? [] : [payload as Line]
    }))
  }
  catch {
    return []
  }
}

export type BusDb = DatabaseSync

export function withReadOnlyBus<T>(busPath: string, read: (db: BusDb) => T): T {
  const db = new DatabaseSync(busPath, { readOnly: true })
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { StoredEvent } from './stored.js'
import { payloadOf, Rejection } from './stored.js'

export const EITHER_JOURNAL = 'either'

export interface EventsQuery {
  types?: readonly string[]
  card?: number
  pr?: number | null
  task?: string
  since?: number
  before?: number
  ids?: readonly number[]
  keys?: readonly string[]
  ts?: string
  actorPrefix?: string
  legacy?: boolean | typeof EITHER_JOURNAL
  newestFirst?: boolean
  limit?: number
}

export type EventData = Record<string, unknown>

export interface EventRow extends StoredEvent {
  actor: string | null
  legacy: boolean
  data: EventData | null
}

interface RawRow extends Omit<EventRow, 'legacy' | 'data'> {
  legacy: number
}

const ROW_COLUMNS = 'id, ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy'

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function dataOf(event: StoredEvent): EventData | null {
  try {
    return payloadOf(event)
  }
  catch (error) {
    if (error instanceof Rejection)
      return null
    throw error
  }
}

function rowOf(raw: RawRow): EventRow {
  const stored = { ...raw, id: Number(raw.id), card_id: raw.card_id === null ? null : Number(raw.card_id), pr: raw.pr === null ? null : Number(raw.pr) }
  return { ...stored, legacy: Number(raw.legacy) === 1, data: dataOf(stored) }
}

function whereOf(query: EventsQuery): { clauses: string[], values: SQLInputValue[] } {
  const clauses: string[] = []
  const values: SQLInputValue[] = []
  const add = (clause: string, ...bound: SQLInputValue[]): void => {
    clauses.push(clause)
    values.push(...bound)
  }
  const legacy = query.legacy ?? false
  if (legacy !== EITHER_JOURNAL)
    add('legacy = ?', legacy ? 1 : 0)
  if (query.types !== undefined)
    add(`type IN (${placeholders(query.types)})`, ...query.types)
  if (query.card !== undefined)
    add('card_id = ?', query.card)
  if (query.pr === null)
    add('pr IS NULL')
  else if (query.pr !== undefined)
    add('pr = ?', query.pr)
  if (query.task !== undefined)
    add(`json_valid(payload) AND json_extract(payload, '$.task_key') = ?`, query.task)
  if (query.since !== undefined)
    add('id > ?', query.since)
  if (query.before !== undefined)
    add('id < ?', query.before)
  if (query.ids !== undefined)
    add(`id IN (${placeholders(query.ids)})`, ...query.ids)
  if (query.keys !== undefined)
    add(`dedupe_key IN (${placeholders(query.keys)})`, ...query.keys)
  if (query.ts !== undefined)
    add('ts = ?', query.ts)
  if (query.actorPrefix !== undefined)
    add('substr(actor, 1, ?) = ?', query.actorPrefix.length, query.actorPrefix)
  return { clauses, values }
}

export function events(db: DatabaseSync, query: EventsQuery = {}): EventRow[] {
  if (query.types?.length === 0 || query.ids?.length === 0 || query.keys?.length === 0)
    return []
  const { clauses, values } = whereOf(query)
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  const limit = query.limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(query.limit))}`
  const sql = `SELECT ${ROW_COLUMNS} FROM events${where} ORDER BY id ${query.newestFirst === true ? 'DESC' : 'ASC'}${limit}`
  return (db.prepare(sql).all(...values) as unknown as RawRow[]).map(rowOf)
}

export function all(db: DatabaseSync, types?: readonly string[], query: Omit<EventsQuery, 'types'> = {}): EventRow[] {
  return events(db, { ...query, types })
}

export function ofCard(db: DatabaseSync, card: number, query: Omit<EventsQuery, 'card'> = {}): EventRow[] {
  return events(db, { ...query, card })
}

export function ofPr(db: DatabaseSync, pr: number, query: Omit<EventsQuery, 'pr'> = {}): EventRow[] {
  return events(db, { ...query, pr })
}

export function byId(db: DatabaseSync, id: number): EventRow | null {
  return events(db, { ids: [id], legacy: EITHER_JOURNAL })[0] ?? null
}

export function latest(db: DatabaseSync, query: EventsQuery): EventRow | null {
  return events(db, { ...query, newestFirst: true, limit: 1 })[0] ?? null
}

export function perCard(db: DatabaseSync, query: Omit<EventsQuery, 'card'> = {}): Map<number, EventRow[]> {
  const grouped = new Map<number, EventRow[]>()
  for (const row of events(db, query)) {
    if (row.card_id === null)
      continue
    const rows = grouped.get(row.card_id) ?? []
    rows.push(row)
    grouped.set(row.card_id, rows)
  }
  return new Map([...grouped].sort(([a], [b]) => a - b))
}

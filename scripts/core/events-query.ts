import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { StoredEvent } from './stored.js'
import { SHARD_EXPIRED, SHARD_ISSUED, SHARD_REVOKED, SHARD_USED } from './events.js'
import { payloadOf, Rejection } from './stored.js'

export const EITHER_JOURNAL = 'either'

export interface EventsQuery {
  types?: readonly string[]
  card?: number
  pr?: number | null
  head?: string
  task?: string
  since?: number
  before?: number
  ids?: readonly number[]
  keys?: readonly string[]
  ts?: string
  actorPrefix?: string
  mentions?: string
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
  if (query.head !== undefined)
    add('head = ?', query.head)
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
  if (query.mentions !== undefined)
    add('instr(payload, ?) > 0', query.mentions)
  return { clauses, values }
}

interface EventsSql {
  columns: string
  alias?: string
  where: string
  newestFirst: boolean
  limit: string
}

function eventsSql(sql: EventsSql): string {
  return `SELECT ${sql.columns} FROM events${sql.alias === undefined ? '' : ` AS ${sql.alias}`}${sql.where} ORDER BY id ${sql.newestFirst ? 'DESC' : 'ASC'}${sql.limit}`
}

export function latestOfCardWhere(alias: string, condition: string): string {
  return eventsSql({ columns: `${alias}.id AS id, ${alias}.payload AS payload`, alias, where: ` WHERE ${alias}.legacy = 0 AND ${alias}.card_id = ? AND ${condition}`, newestFirst: true, limit: ' LIMIT 1' })
}

export function events(db: DatabaseSync, query: EventsQuery = {}): EventRow[] {
  if (query.types?.length === 0 || query.ids?.length === 0 || query.keys?.length === 0)
    return []
  const { clauses, values } = whereOf(query)
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  const limit = query.limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(query.limit))}`
  const sql = eventsSql({ columns: ROW_COLUMNS, where, newestFirst: query.newestFirst === true, limit })
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

const UNENDED_WINDOW_SHARDS = `
  SELECT issued.id AS event_id, json_extract(issued.payload, '$.id') AS id, json_extract(issued.payload, '$.by') AS by,
    json_extract(issued.payload, '$.scope') AS scope, json_extract(issued.payload, '$.until') AS until
  FROM events issued
  WHERE issued.type = '${SHARD_ISSUED}' AND json_extract(issued.payload, '$.window') = 1
    AND NOT EXISTS (SELECT 1 FROM events ended WHERE ended.type IN ('${SHARD_REVOKED}', '${SHARD_EXPIRED}') AND json_extract(ended.payload, '$.id') = json_extract(issued.payload, '$.id'))
`

const WINDOW_SHARDS = `${UNENDED_WINDOW_SHARDS} ORDER BY issued.id DESC`

export const WINDOW_SHARDS_LIVE_AT = `${UNENDED_WINDOW_SHARDS} AND json_extract(issued.payload, '$.until') > ?`

export function unspentShardsOf(card: string, pr: string): string {
  return `
  SELECT issued.id AS event_id, json_extract(issued.payload, '$.id') AS id, json_extract(issued.payload, '$.under') AS under FROM events issued
  WHERE issued.type = '${SHARD_ISSUED}' AND (issued.card_id = ${card} OR issued.pr = ${pr})
    AND NOT EXISTS (SELECT 1 FROM events used WHERE used.type = '${SHARD_USED}' AND json_extract(used.payload, '$.id') = json_extract(issued.payload, '$.id'))
`
}

const SHARD_USED_BY_RUN = `SELECT 1 FROM events WHERE type = '${SHARD_USED}' AND json_extract(payload, '$.run') = ? LIMIT 1`

export interface ShardRow {
  id: unknown
  by: unknown
  scope: unknown
  until: unknown
}

export interface UnspentShardRow {
  id: unknown
  under: unknown
}

export function unendedWindowShardRows(db: DatabaseSync): ShardRow[] {
  return db.prepare(WINDOW_SHARDS).all() as unknown as ShardRow[]
}

export function unspentShardRows(db: DatabaseSync, cardId: number, pr: number | null): UnspentShardRow[] {
  return db.prepare(`${unspentShardsOf('?', '?')} ORDER BY issued.id`).all(cardId, pr) as unknown as UnspentShardRow[]
}

export function shardUsedByRun(db: DatabaseSync, run: string): boolean {
  return db.prepare(SHARD_USED_BY_RUN).get(run) !== undefined
}

const CARD_IDS_IN_EVENTS = `SELECT DISTINCT card_id FROM events WHERE card_id IS NOT NULL`

export function cardIdsInEvents(db: DatabaseSync): number[] {
  return (db.prepare(CARD_IDS_IN_EVENTS).all() as { card_id: number }[]).map(row => Number(row.card_id))
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

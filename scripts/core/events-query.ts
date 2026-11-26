import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite'
import type { StoredEvent } from './stored.js'
import { CARD_ADMITTED, MERGE_DONE, PR_CLOSED, PR_STATUS_SET, PROCESS_HEARTBEAT, REVIEW_RECORDED, SHARD_EXPIRED, SHARD_ISSUED, SHARD_REVOKED, SHARD_USED } from './events.js'
import { payloadOf, Rejection } from './stored.js'

export type { Reading, ReadProjection, StaleProjection } from './bus-readings.js'
export { readCurrent, staleProjection } from './bus-readings.js'

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
  keyPrefix?: string
  ts?: string
  from?: string
  actorPrefix?: string
  exceptActor?: string
  notBy?: string
  mentions?: string
  withCard?: boolean
  withPr?: boolean
  valid?: boolean
  present?: readonly string[]
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
  if (query.keyPrefix !== undefined)
    add('substr(dedupe_key, 1, ?) = ?', query.keyPrefix.length, query.keyPrefix)
  if (query.ts !== undefined)
    add('ts = ?', query.ts)
  if (query.from !== undefined)
    add('ts >= ?', query.from)
  if (query.actorPrefix !== undefined)
    add('substr(actor, 1, ?) = ?', query.actorPrefix.length, query.actorPrefix)
  if (query.exceptActor !== undefined)
    add('actor != ?', query.exceptActor)
  if (query.notBy !== undefined)
    add('actor IS NOT ?', query.notBy)
  if (query.mentions !== undefined)
    add('instr(payload, ?) > 0', query.mentions)
  if (query.withCard === true)
    add('card_id IS NOT NULL')
  if (query.withPr === true)
    add('pr IS NOT NULL')
  if (query.valid === true || query.present !== undefined)
    add('json_valid(payload)')
  if (query.present !== undefined)
    add(`NOT EXISTS (SELECT 1 FROM json_each(?) AS wanted WHERE json_extract(payload, '$.' || wanted.value) IS NULL)`, JSON.stringify(query.present))
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

export function eventsWhere(alias: string, columns: string, condition: string): string {
  return eventsSql({ columns, alias, where: ` WHERE ${condition}`, newestFirst: false, limit: '' })
}

export function anEventWhere(alias: string, condition: string): string {
  return `EXISTS (${eventsWhere(alias, '1', condition)})`
}

export function latestEventIdWhere(alias: string, condition: string): string {
  return `(SELECT max(${alias}.id) FROM events AS ${alias} WHERE ${condition})`
}

function matchesNothing(query: EventsQuery): boolean {
  return query.types?.length === 0 || query.ids?.length === 0 || query.keys?.length === 0
}

function whereClause(query: EventsQuery): { where: string, values: SQLInputValue[] } {
  const { clauses, values } = whereOf(query)
  return { where: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`, values }
}

export function events(db: DatabaseSync, query: EventsQuery = {}): EventRow[] {
  if (matchesNothing(query))
    return []
  const { where, values } = whereClause(query)
  const limit = query.limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(query.limit))}`
  const sql = eventsSql({ columns: ROW_COLUMNS, where, newestFirst: query.newestFirst === true, limit })
  return (db.prepare(sql).all(...values) as unknown as RawRow[]).map(rowOf)
}

export const BY_CARD = 'card_id'

export type EventKey = typeof BY_CARD | `$.${string}`

export function lastPer(db: DatabaseSync, key: EventKey, query: EventsQuery = {}): EventRow[] {
  if (matchesNothing(query))
    return []
  const byCard = key === BY_CARD
  const { where, values } = whereClause(byCard ? query : { ...query, valid: true })
  const sql = eventsSql({ columns: ROW_COLUMNS, where: ` WHERE id IN (SELECT max(id) FROM events${where} GROUP BY ${byCard ? BY_CARD : 'json_extract(payload, ?)'})`, newestFirst: false, limit: '' })
  return (db.prepare(sql).all(...values, ...byCard ? [] : [key]) as unknown as RawRow[]).map(rowOf)
}

const LAST_EVENT_ID = 'SELECT coalesce(max(id), 0) AS id FROM events'
const LAST_EVENT_ID_UNINDEXED = 'SELECT coalesce(max(id), 0) AS id FROM events NOT INDEXED'
const EVENT_ROWS_UNINDEXED = `SELECT ${ROW_COLUMNS} FROM events NOT INDEXED WHERE id <= ? ORDER BY id`
const DUPLICATE_KEY_UNINDEXED = 'SELECT dedupe_key FROM events NOT INDEXED GROUP BY dedupe_key HAVING count(*) > 1 LIMIT 1'
export const EVENTS_COUNT_UNINDEXED = 'SELECT count(*) FROM events NOT INDEXED;'
const EVENTS_SINCE = 'SELECT count(*) AS events, count(DISTINCT card_id) AS cards FROM events WHERE ts >= ?'
const WATERMARK_ROWS = 'SELECT projection, through_event_id FROM projection_watermarks ORDER BY projection'
const PROCESS_BEATS = 'SELECT process, ts FROM heartbeats WHERE type = ? AND substr(process, 1, ?) = ? ORDER BY process'

export function lastEventId(db: DatabaseSync): number {
  return Number((db.prepare(LAST_EVENT_ID).get() as { id: number }).id)
}

export function lastEventIdUnindexed(db: DatabaseSync): number {
  return Number((db.prepare(LAST_EVENT_ID_UNINDEXED).get() as { id: number }).id)
}

export function eventRowsUnindexed(db: DatabaseSync, throughId: number): Iterable<Record<string, SQLOutputValue>> {
  return db.prepare(EVENT_ROWS_UNINDEXED).iterate(throughId)
}

export function duplicateKeyUnindexed(db: DatabaseSync): string | null {
  return (db.prepare(DUPLICATE_KEY_UNINDEXED).get() as { dedupe_key: string } | undefined)?.dedupe_key ?? null
}

export interface EventsSince {
  events: number
  cards: number
}

export function eventsSince(db: DatabaseSync, ts: string): EventsSince {
  const row = db.prepare(EVENTS_SINCE).get(ts) as { events: number, cards: number }
  return { events: Number(row.events), cards: Number(row.cards) }
}

export interface WatermarkRow {
  projection: string
  through_event_id: number
}

export function watermarkRows(db: DatabaseSync): WatermarkRow[] {
  return db.prepare(WATERMARK_ROWS).all() as unknown as WatermarkRow[]
}

export interface ProcessBeatRow {
  process: string
  ts: string
}

export function processBeats(db: DatabaseSync, prefix = ''): ProcessBeatRow[] {
  return db.prepare(PROCESS_BEATS).all(PROCESS_HEARTBEAT, prefix.length, prefix) as unknown as ProcessBeatRow[]
}

export interface EventStamp {
  id: number
  ts: string
}

export interface Signs {
  types: readonly string[]
  actorPrefix: string
}

export function signStampsSince(db: DatabaseSync, since: number, signs: Signs): EventStamp[] {
  const matched = [
    ...events(db, { types: signs.types, since, legacy: EITHER_JOURNAL }),
    ...events(db, { actorPrefix: signs.actorPrefix, since, legacy: EITHER_JOURNAL }),
  ]
  const stamps = new Map(matched.map(row => [row.id, row.ts] as const))
  return [...stamps].sort(([a], [b]) => a - b).map(([id, ts]) => ({ id, ts }))
}

export function eventLog(db: DatabaseSync): Record<string, SQLOutputValue>[] {
  return db.prepare(eventsSql({ columns: ROW_COLUMNS, where: '', newestFirst: false, limit: '' })).all()
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

export const REVIEWS_OF_A_PR = `
  SELECT id, head, json_extract(payload, '$.verdict') AS verdict, json_extract(payload, '$.card_body') AS card_body FROM events
  WHERE type = '${REVIEW_RECORDED}' AND legacy = 0 AND pr = ? ORDER BY id
`

export interface ReviewRow {
  head: string | null
  verdict: unknown
  card_body: unknown
}

export function reviewsOfPr(db: DatabaseSync, pr: number): ReviewRow[] {
  return db.prepare(REVIEWS_OF_A_PR).all(pr) as unknown as ReviewRow[]
}

export function bodiesAdmittedBySourceForAPr(source: string): string {
  return `
  SELECT DISTINCT json_extract(payload, '$.bodySha') AS body FROM events
  WHERE type = '${CARD_ADMITTED}' AND legacy = 0 AND json_extract(payload, '$.source') = '${source}' AND json_type(payload, '$.bodySha') = 'text'
    AND card_id IN (SELECT card_id FROM events WHERE type = '${REVIEW_RECORDED}' AND legacy = 0 AND pr = ? AND card_id IS NOT NULL)
`
}

export function bodiesAdmittedBySource(db: DatabaseSync, query: string, pr: number): Set<string> {
  return new Set((db.prepare(query).all(pr) as { body: string }[]).map(row => row.body))
}

export const MERGE_RECORD = `
  SELECT payload FROM events
  WHERE pr = ? AND (type = '${MERGE_DONE}' OR (type = '${PR_CLOSED}' AND json_extract(payload, '$.merged') = 1))
  ORDER BY CASE type WHEN '${MERGE_DONE}' THEN 0 ELSE 1 END, id LIMIT 1
`

const JSON_TRUE: readonly unknown[] = [1, true]

export function mergeRecordOf(db: DatabaseSync, pr: number): EventData | null {
  const ofThePr = events(db, { pr, types: [MERGE_DONE, PR_CLOSED], legacy: EITHER_JOURNAL })
  const record = ofThePr.find(row => row.type === MERGE_DONE) ?? ofThePr.find(row => row.type === PR_CLOSED && JSON_TRUE.includes(row.data?.merged))
  return record === undefined ? null : record.data ?? {}
}

export const LAST_STATUS_SET_ON_HEAD = `SELECT json_extract(payload, '$.step') AS step, json_extract(payload, '$.state') AS state FROM events WHERE type = '${PR_STATUS_SET}' AND legacy = 0 AND pr = ? AND head = ? ORDER BY id DESC LIMIT 1`

export interface StatusSetRow {
  step: unknown
  state: unknown
}

export function lastStatusSetOnHead(db: DatabaseSync, pr: number, head: string): StatusSetRow | null {
  return db.prepare(LAST_STATUS_SET_ON_HEAD).get(pr, head) as StatusSetRow | undefined ?? null
}

const LATEST_PR = 'SELECT max(pr) AS pr FROM events'

export function latestPrInTheBus(db: DatabaseSync): number {
  return Number((db.prepare(LATEST_PR).get() as { pr: number | null }).pr ?? 0)
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

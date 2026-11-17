import type { DatabaseSync } from 'node:sqlite'
import type { EventType, WaitLifter } from './events.js'
import type { ReadProjection } from './projection-types.js'
import { CARD_CLOSED, CARD_DROPPED, LANE_ASSIGNED, MERGE_DONE, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED } from './events.js'
import { CARDS, FOLDED_ON_APPEND, OWNER_WAITS, PROJECTION_TYPES } from './projection-types.js'

export { CARDS, DECISIONS, OWNER_WAITS, PROJECTION_TYPES, REDUCED_IN_ORDER } from './projection-types.js'
export type { ReadProjection } from './projection-types.js'

export const WATERMARKS = 'projection_watermarks'
export const IN_ORDER_MARK = 'snapshot'

interface Mark {
  mark: string
  types: readonly EventType[]
}

export const CARD_TYPES_FOLDED_ON_APPEND: readonly EventType[] = FOLDED_ON_APPEND[CARDS] ?? []

function marksOf(projection: ReadProjection): readonly Mark[] {
  return [{ mark: projection, types: FOLDED_ON_APPEND[projection] ?? PROJECTION_TYPES[projection] }, { mark: IN_ORDER_MARK, types: PROJECTION_TYPES[projection] }]
}

export interface StaleProjection {
  projection: ReadProjection
  type: EventType
  latest: number
  through: number
}

export type Reading<T> = { stale: StaleProjection } | { stale: null, rows: T, at: number }

export function staleLine(stale: StaleProjection): string {
  return `${stale.projection} is stale: reduced through event ${stale.through}, behind ${stale.type} ${stale.latest}`
}

interface Latest {
  type: EventType
  latest: number
  at: string | null
  reducedAt: string | null
}

export interface Behind extends StaleProjection {
  events: number
  seconds: number | null
}

export interface LastReduced<T> {
  rows: T
  behind: Behind | null
}

const MS_PER_SECOND = 1000
const NOTHING_REDUCED = 0

function markOf(db: DatabaseSync, mark: string): number {
  const row = db.prepare(`SELECT through_event_id FROM ${WATERMARKS} WHERE projection = ?`).get(mark) as { through_event_id: number } | undefined
  return Number(row?.through_event_id ?? 0)
}

export function latestOfEachType(db: DatabaseSync, types: readonly EventType[], reduced: number = NOTHING_REDUCED): Latest[] {
  return (db.prepare(`SELECT type, max(id) AS latest, ts, (SELECT reduced.ts FROM events AS reduced WHERE reduced.id = ?) AS reduced_at FROM events WHERE legacy = 0 AND type IN (SELECT value FROM json_each(?)) GROUP BY type ORDER BY latest DESC`).all(reduced, JSON.stringify(types)) as { type: EventType, latest: number, ts: string | null, reduced_at: string | null }[])
    .map(row => ({ type: row.type, latest: Number(row.latest), at: row.ts, reducedAt: row.reduced_at }))
}

function secondsBetween(from: string | null, to: string | null): number | null {
  const lag = from === null || to === null ? Number.NaN : Date.parse(to) - Date.parse(from)
  return Number.isNaN(lag) ? null : Math.max(0, Math.round(lag / MS_PER_SECOND))
}

export function staleProjection(db: DatabaseSync, projection: ReadProjection): StaleProjection | null {
  const marks = marksOf(projection).map(each => ({ types: each.types, through: markOf(db, each.mark) }))
  const reach = (type: EventType): number => Math.max(...marks.filter(each => each.types.includes(type)).map(each => each.through))
  const behind = latestOfEachType(db, PROJECTION_TYPES[projection]).find(each => each.latest > reach(each.type))
  return behind === undefined ? null : { projection, type: behind.type, latest: behind.latest, through: reach(behind.type) }
}

function behindProjection(db: DatabaseSync, projection: ReadProjection): Behind | null {
  const stale = staleProjection(db, projection)
  if (stale === null)
    return null
  const latest = latestOfEachType(db, [stale.type], stale.through)[0]
  return { ...stale, events: stale.latest - stale.through, seconds: secondsBetween(latest?.reducedAt ?? null, latest?.at ?? null) }
}

export function copyEvent(db: DatabaseSync, projections: readonly ReadProjection[]): number {
  const types = [...new Set(projections.flatMap(projection => PROJECTION_TYPES[projection]))]
  const held = latestOfEachType(db, types).map(each => each.latest)
  return Math.max(0, ...held)
}

export function readCurrent<T>(db: DatabaseSync, projections: readonly ReadProjection[], read: () => T): Reading<T> {
  for (const projection of projections) {
    const stale = staleProjection(db, projection)
    if (stale !== null)
      return { stale }
  }
  const at = copyEvent(db, projections)
  return { stale: null, rows: read(), at }
}

export function behindLine(behind: Behind): string {
  const seconds = behind.seconds === null ? '' : ` and ${behind.seconds} s`
  return `${behind.projection} shows the last reduced list, behind by ${behind.events} events${seconds}: reduced through event ${behind.through}, behind ${behind.type} ${behind.latest}`
}

export function readLastReduced<T>(db: DatabaseSync, projections: readonly ReadProjection[], read: () => T): LastReduced<T> {
  const behind = projections.map(projection => behindProjection(db, projection)).find(each => each !== null) ?? null
  return { rows: read(), behind }
}

export const OWNER_WAIT_NEEDS = ['decision', 'merge', 'command'] as const
export const OPEN_WAIT = 'open'
export const CLOSED_WAIT = 'closed'

export type OwnerWaitNeed = typeof OWNER_WAIT_NEEDS[number]

export interface OwnerWait {
  id: string
  need: OwnerWaitNeed
  text: string
  command: string | null
  card: number | null
  pr: number | null
  since: string
  lifter: Extract<WaitLifter, 'owner' | 'window'>
  decision: string | null
}

const OPEN_OWNER_WAITS = `
  SELECT wait.id, wait.need, wait.text, wait.command, wait.card_id AS card, wait.pr, wait.opened_at AS since,
    (SELECT json_extract(opened.payload, '$.decision') FROM events AS opened WHERE opened.dedupe_key = '${OWNER_WAIT_OPENED}:' || wait.id AND opened.type = '${OWNER_WAIT_OPENED}' AND json_valid(opened.payload)) AS decision
  FROM ${OWNER_WAITS} AS wait
  WHERE wait.state = '${OPEN_WAIT}'
    AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${OWNER_WAIT_CLOSED}' AND closed.legacy = 0 AND json_valid(closed.payload) AND json_extract(closed.payload, '$.id') = wait.id)
  ORDER BY CAST(substr(wait.id, 2) AS INTEGER), wait.id
`

function liftedBy(decision: string | null): OwnerWait['lifter'] {
  return decision === null ? 'owner' : 'window'
}

export function openOwnerWaits(db: DatabaseSync): OwnerWait[] {
  return (db.prepare(OPEN_OWNER_WAITS).all() as unknown as Omit<OwnerWait, 'lifter'>[]).map(row => ({ ...row, lifter: liftedBy(row.decision) }))
}

export function lastReducedOwnerWaits(db: DatabaseSync): LastReduced<OwnerWait[]> {
  return readLastReduced(db, [OWNER_WAITS], () => openOwnerWaits(db))
}

const LATEST_ASSIGNMENT = `SELECT id, json_extract(payload, '$.lane') AS lane, json_extract(payload, '$.reason') AS reason, json_extract(payload, '$.after') AS after FROM events WHERE legacy = 0 AND type = '${LANE_ASSIGNED}' AND card_id = ? ORDER BY id DESC LIMIT 1`

const LATEST_END = `SELECT max(id) AS id FROM events WHERE legacy = 0 AND card_id = ? AND type IN ('${CARD_DROPPED}', '${CARD_CLOSED}', '${MERGE_DONE}')`

export interface Assignment { id: number, lane: unknown, reason: unknown, after: string | null }

export function latestAssignment(db: DatabaseSync, cardId: number): Assignment | undefined {
  return db.prepare(LATEST_ASSIGNMENT).get(cardId) as Assignment | undefined
}

export function currentLane(db: DatabaseSync, cardId: number): string | null {
  const assigned = latestAssignment(db, cardId)
  if (assigned === undefined || typeof assigned.lane !== 'string')
    return null
  const ended = (db.prepare(LATEST_END).get(cardId) as { id: number | null }).id
  return ended !== null && Number(ended) > Number(assigned.id) ? null : assigned.lane
}

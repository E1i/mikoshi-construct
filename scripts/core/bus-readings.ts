import type { DatabaseSync } from 'node:sqlite'
import type { EventType } from './events.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_CLOSED, CARD_DEFERRED, CARD_DROPPED, CARD_FELL, CARD_MOVED, CARD_STARTED, CARD_STOPPED, CARD_WAITING, DECISION_EXPIRED, DECISION_RECORDED, DECISIONS_IMPORTED, LANE_ASSIGNED, MERGE_DONE, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PR_CLOSED, PR_OBSERVED, PR_OPENED, REVIEW_RECORDED } from './events.js'

export const WATERMARKS = 'projection_watermarks'
export const IN_ORDER_MARK = 'snapshot'
export const OWNER_WAITS = 'owner_waits'
export const DECISIONS = 'decisions'
export const CARDS = 'cards'

interface Mark {
  mark: string
  types: readonly EventType[]
}

const ENDING_A_CARD: readonly EventType[] = [PR_CLOSED, MERGE_DONE, CARD_CLOSED, CARD_MOVED, CARD_DROPPED]
const RECORDING_A_DECISION: readonly EventType[] = [DECISION_RECORDED, DECISIONS_IMPORTED]
export const CARD_TYPES_FOLDED_ON_APPEND: readonly EventType[] = [REVIEW_RECORDED, MERGE_DONE, CARD_STOPPED]

export const PROJECTION_TYPES = {
  [OWNER_WAITS]: [OWNER_WAIT_OPENED, OWNER_WAIT_CLOSED, CARD_WAITING, CARD_ADMITTED, ...RECORDING_A_DECISION, ...ENDING_A_CARD],
  [DECISIONS]: [...RECORDING_A_DECISION, DECISION_EXPIRED, ...ENDING_A_CARD],
  [CARDS]: [...CARD_TYPES_FOLDED_ON_APPEND, CARD_ADMITTED, CARD_STARTED, CARD_ANSWERED, CARD_CLOSED, CARD_FELL, CARD_MOVED, CARD_DEFERRED, CARD_DROPPED, PR_OBSERVED, PR_OPENED, PR_CLOSED, ...RECORDING_A_DECISION],
} as const satisfies Record<string, readonly EventType[]>

export type ReadProjection = keyof typeof PROJECTION_TYPES

export const REDUCED_IN_ORDER: readonly ReadProjection[] = [OWNER_WAITS, DECISIONS]

const MARKS: Record<ReadProjection, readonly Mark[]> = {
  [OWNER_WAITS]: [{ mark: OWNER_WAITS, types: PROJECTION_TYPES[OWNER_WAITS] }, { mark: IN_ORDER_MARK, types: PROJECTION_TYPES[OWNER_WAITS] }],
  [DECISIONS]: [{ mark: DECISIONS, types: PROJECTION_TYPES[DECISIONS] }, { mark: IN_ORDER_MARK, types: PROJECTION_TYPES[DECISIONS] }],
  [CARDS]: [{ mark: IN_ORDER_MARK, types: PROJECTION_TYPES[CARDS] }, { mark: CARDS, types: CARD_TYPES_FOLDED_ON_APPEND }],
}

export interface StaleProjection {
  projection: ReadProjection
  type: EventType
  latest: number
  through: number
}

export type Reading<T> = { stale: StaleProjection } | { stale: null, rows: T }

export function staleLine(stale: StaleProjection): string {
  return `${stale.projection} is stale: reduced through event ${stale.through}, behind ${stale.type} ${stale.latest}`
}

function markOf(db: DatabaseSync, mark: string): number {
  const row = db.prepare(`SELECT through_event_id FROM ${WATERMARKS} WHERE projection = ?`).get(mark) as { through_event_id: number } | undefined
  return Number(row?.through_event_id ?? 0)
}

function latestOfEachType(db: DatabaseSync, types: readonly EventType[]): { type: EventType, latest: number }[] {
  return (db.prepare(`SELECT type, max(id) AS latest FROM events WHERE legacy = 0 AND type IN (SELECT value FROM json_each(?)) GROUP BY type ORDER BY latest DESC`).all(JSON.stringify(types)) as { type: EventType, latest: number }[])
    .map(row => ({ type: row.type, latest: Number(row.latest) }))
}

export function staleProjection(db: DatabaseSync, projection: ReadProjection): StaleProjection | null {
  const marks = MARKS[projection].map(each => ({ types: each.types, through: markOf(db, each.mark) }))
  const reach = (type: EventType): number => Math.max(...marks.filter(each => each.types.includes(type)).map(each => each.through))
  const behind = latestOfEachType(db, PROJECTION_TYPES[projection]).find(each => each.latest > reach(each.type))
  return behind === undefined ? null : { projection, type: behind.type, latest: behind.latest, through: reach(behind.type) }
}

export function readCurrent<T>(db: DatabaseSync, projections: readonly ReadProjection[], read: () => T): Reading<T> {
  for (const projection of projections) {
    const stale = staleProjection(db, projection)
    if (stale !== null)
      return { stale }
  }
  return { stale: null, rows: read() }
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
}

const OPEN_OWNER_WAITS = `
  SELECT wait.id, wait.need, wait.text, wait.command, wait.card_id AS card, wait.pr, wait.opened_at AS since FROM ${OWNER_WAITS} AS wait
  WHERE wait.state = '${OPEN_WAIT}'
    AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${OWNER_WAIT_CLOSED}' AND closed.legacy = 0 AND json_valid(closed.payload) AND json_extract(closed.payload, '$.id') = wait.id)
  ORDER BY CAST(substr(wait.id, 2) AS INTEGER), wait.id
`

export function openOwnerWaits(db: DatabaseSync): OwnerWait[] {
  return (db.prepare(OPEN_OWNER_WAITS).all() as unknown as OwnerWait[]).map(row => ({ ...row }))
}

export function currentOwnerWaits(db: DatabaseSync): Reading<OwnerWait[]> {
  return readCurrent(db, [OWNER_WAITS], () => openOwnerWaits(db))
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

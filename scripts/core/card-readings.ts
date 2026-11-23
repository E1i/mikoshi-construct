import type { DatabaseSync } from 'node:sqlite'
import type { LastReduced, OwnerWait } from './bus-readings.js'
import { CLOSED_WAIT, OPEN_WAIT, OWNER_WAITS, readLastReduced } from './bus-readings.js'
import { CARD_BODIES } from './card-bodies.js'
import { EITHER_JOURNAL, events } from './events-query.js'
import { OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED } from './events.js'

const OPEN_OWNER_WAITS = `
  SELECT id, need, text, command, card_id AS card, pr, opened_at AS since
  FROM ${OWNER_WAITS}
  WHERE state = '${OPEN_WAIT}'
  ORDER BY CAST(substr(id, 2) AS INTEGER), id
`

const CLOSED_WAIT_IDS = `SELECT id FROM ${OWNER_WAITS} WHERE state = '${CLOSED_WAIT}' ORDER BY id`

function liftedBy(decision: string | null): OwnerWait['lifter'] {
  return decision === null ? 'owner' : 'window'
}

function closedByAnEvent(db: DatabaseSync): Set<unknown> {
  return new Set(events(db, { types: [OWNER_WAIT_CLOSED] }).map(closed => closed.data?.id))
}

function decisionsOfTheOpenings(db: DatabaseSync, ids: readonly string[]): Map<string, string | null> {
  const opened = events(db, { types: [OWNER_WAIT_OPENED], keys: ids.map(id => `${OWNER_WAIT_OPENED}:${id}`), legacy: EITHER_JOURNAL })
  return new Map(opened.map(event => [event.dedupe_key.slice(OWNER_WAIT_OPENED.length + 1), (event.data?.decision ?? null) as string | null]))
}

export function openOwnerWaits(db: DatabaseSync): OwnerWait[] {
  const closed = closedByAnEvent(db)
  const open = (db.prepare(OPEN_OWNER_WAITS).all() as unknown as Omit<OwnerWait, 'lifter' | 'decision'>[]).filter(wait => !closed.has(wait.id))
  const decisions = decisionsOfTheOpenings(db, open.map(wait => wait.id))
  return open.map((wait) => {
    const decision = decisions.get(wait.id) ?? null
    return { ...wait, decision, lifter: liftedBy(decision) }
  })
}

export function lastReducedOwnerWaits(db: DatabaseSync): LastReduced<OwnerWait[]> {
  return readLastReduced(db, [OWNER_WAITS], () => openOwnerWaits(db))
}

export function closedWaitIds(db: DatabaseSync): string[] {
  return (db.prepare(CLOSED_WAIT_IDS).all() as { id: string }[]).map(row => String(row.id))
}

const A_WAIT_CLOSED_BEFORE = `SELECT 1 FROM ${OWNER_WAITS} WHERE id = ? AND state = '${CLOSED_WAIT}' AND event_id < ? LIMIT 1`

export function waitClosedBefore(db: DatabaseSync, id: string, eventId: number): boolean {
  return db.prepare(A_WAIT_CLOSED_BEFORE).get(id, eventId) !== undefined
}

export interface AdmittedBody {
  admission_event_id: number
  touches: unknown[]
  creates: unknown[]
}

const BODY_ADMITTED_AFTER = `SELECT admission_event_id, touches, creates FROM ${CARD_BODIES} WHERE card_id = ? AND admission_event_id > ?`

function listOf(stored: unknown): unknown[] {
  if (typeof stored !== 'string')
    return []
  const parsed = JSON.parse(stored) as unknown
  return Array.isArray(parsed) ? parsed : [parsed]
}

export function bodyAdmittedAfter(db: DatabaseSync, cardId: number, eventId: number): AdmittedBody | null {
  const row = db.prepare(BODY_ADMITTED_AFTER).get(cardId, eventId) as { admission_event_id: number, touches: unknown, creates: unknown } | undefined
  return row === undefined ? null : { admission_event_id: Number(row.admission_event_id), touches: listOf(row.touches), creates: listOf(row.creates) }
}

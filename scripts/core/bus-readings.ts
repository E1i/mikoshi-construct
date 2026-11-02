import type { DatabaseSync } from 'node:sqlite'
import { CARD_CLOSED, CARD_DROPPED, LANE_ASSIGNED, MERGE_DONE, OWNER_WAIT_CLOSED } from './events.js'

export const OWNER_WAITS = 'owner_waits'
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

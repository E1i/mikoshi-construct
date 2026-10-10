import type { DatabaseSync } from 'node:sqlite'
import { CHAIN_OBSERVED } from './chain.js'
import { MERGE_DONE } from './executor.js'
import { REVIEW_RECORDED } from './review-worker.js'

export const CARD_ADMITTED = 'card.admitted'
export const PR_OBSERVED = 'pr.observed'
export const OPERATOR_WORK_EVENTS = [REVIEW_RECORDED, MERGE_DONE, CHAIN_OBSERVED, CARD_ADMITTED] as const

const WORK_SINCE = `
  SELECT later.id FROM events AS later
  WHERE later.id > ? AND later.legacy = 0 AND (
    later.type IN (${OPERATOR_WORK_EVENTS.map(type => `'${type}'`).join(', ')})
    OR (later.type = '${PR_OBSERVED}' AND NOT EXISTS (
      SELECT 1 FROM events AS earlier
      WHERE earlier.type = '${PR_OBSERVED}' AND earlier.pr = later.pr AND earlier.head IS later.head AND earlier.id < later.id
    ))
  )
  ORDER BY later.id LIMIT 1
`

export function lastEventId(db: DatabaseSync): number {
  return (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as { id: number }).id
}

export function operatorWorkSince(db: DatabaseSync, cursor: number): number | null {
  const row = db.prepare(WORK_SINCE).get(cursor) as { id: number } | undefined
  return row?.id ?? null
}

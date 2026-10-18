import type { DatabaseSync } from 'node:sqlite'

export const UPDATE_DONE = 'update.done'

export interface CleanUpdate {
  from: string
  to: string
}

const CLEAN_UPDATES_OF_A_PR = `
  SELECT json_extract(payload, '$.from') AS "from", json_extract(payload, '$.to') AS "to" FROM events
  WHERE type = '${UPDATE_DONE}' AND legacy = 0 AND pr = ? AND json_extract(payload, '$.clean') = 1
  ORDER BY id
`

export function cleanUpdatesOf(db: DatabaseSync, pr: number): CleanUpdate[] {
  return db.prepare(CLEAN_UPDATES_OF_A_PR).all(pr) as unknown as CleanUpdate[]
}

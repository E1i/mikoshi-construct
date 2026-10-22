import { existsSync } from 'node:fs'
import { JOURNAL_HISTORY_ENDS } from '../../src/card/closed.js'
import { BUSY_TIMEOUT_MS } from '../bus/db.js'
import { openDatabase } from '../bus/sqlite.js'

export interface BusMerge {
  task: string
  pr: number
  by: string | null
  commit: string | null
  merged: string | null
  event: number
}

const MERGE_FACTS = `
  SELECT id, card_id, pr, json_extract(payload, '$.merged_by') AS by, json_extract(payload, '$.commit') AS commit_sha, json_extract(payload, '$.merged_at') AS merged
  FROM events
  WHERE type = 'pr.closed' AND legacy = 0 AND json_extract(payload, '$.merged') = 1 AND card_id IS NOT NULL AND pr IS NOT NULL AND ts >= ?
  ORDER BY id
`

export function busMerges(busPath: string): BusMerge[] {
  if (!existsSync(busPath))
    return []
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const rows = db.prepare(MERGE_FACTS).all(JOURNAL_HISTORY_ENDS) as unknown as { id: number, card_id: number, pr: number, by: string | null, commit_sha: string | null, merged: string | null }[]
    return rows.map(row => ({ task: String(row.card_id), pr: row.pr, by: row.by, commit: row.commit_sha, merged: row.merged, event: row.id }))
  }
  finally {
    db.close()
  }
}

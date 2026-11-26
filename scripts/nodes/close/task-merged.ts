import type { EventRow } from '../../core/events-query.js'
import { existsSync } from 'node:fs'
import { JOURNAL_HISTORY_ENDS } from '../../../src/card/closed.js'
import { BUSY_TIMEOUT_MS } from '../../core/db.js'
import { events } from '../../core/events-query.js'
import { PR_CLOSED } from '../../core/events.js'
import { openDatabase } from '../../core/sqlite.js'

export interface BusMerge {
  task: string
  pr: number
  by: string | null
  commit: string | null
  merged: string | null
  event: number
}

const MERGED_FLAGS: readonly unknown[] = [true, 1]

function field(row: EventRow, name: string): string | null {
  return (row.data?.[name] ?? null) as string | null
}

export function busMerges(busPath: string): BusMerge[] {
  if (!existsSync(busPath))
    return []
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    return events(db, { types: [PR_CLOSED], withCard: true, withPr: true, from: JOURNAL_HISTORY_ENDS })
      .filter(row => MERGED_FLAGS.includes(row.data?.merged))
      .map(row => ({ task: String(row.card_id), pr: row.pr!, by: field(row, 'merged_by'), commit: field(row, 'commit'), merged: field(row, 'merged_at'), event: row.id }))
  }
  finally {
    db.close()
  }
}

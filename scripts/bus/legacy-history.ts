import type { DatabaseSync } from 'node:sqlite'
import type { JournalEvent } from '../ghosts/approval.js'
import { writtenBeforeHistoryEnds } from '../../src/card/closed.js'

const LEGACY_LINES = `
  SELECT payload FROM events
  WHERE legacy = 1
  ORDER BY id
`

function entryOf(payload: string): JournalEvent | null {
  try {
    const entry = JSON.parse(payload) as unknown
    return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry as JournalEvent : null
  }
  catch {
    return null
  }
}

export function legacyHistory(db: DatabaseSync): JournalEvent[] {
  return (db.prepare(LEGACY_LINES).all() as { payload: string }[])
    .flatMap((row) => {
      const entry = entryOf(row.payload)
      return entry !== null && writtenBeforeHistoryEnds(entry) ? [entry] : []
    })
}

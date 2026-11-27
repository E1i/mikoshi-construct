import type { DatabaseSync } from 'node:sqlite'
import type { JournalEvent } from '../ladder/approval.js'
import { writtenBeforeHistoryEnds } from '../../src/card/closed.js'
import { events } from './events-query.js'

export function legacyHistory(db: DatabaseSync): JournalEvent[] {
  return events(db, { legacy: true }).flatMap((row) => {
    const entry = row.data as JournalEvent | null
    return entry !== null && writtenBeforeHistoryEnds(entry) ? [entry] : []
  })
}

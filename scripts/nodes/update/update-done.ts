import type { DatabaseSync } from 'node:sqlite'
import { ofPr } from '../../core/events-query.js'
import { UPDATE_DONE } from '../../core/events.js'

export interface CleanUpdate {
  from: string
  to: string
}

const JSON_TRUE: readonly unknown[] = [1, true]

export function cleanUpdatesOf(db: DatabaseSync, pr: number): CleanUpdate[] {
  return ofPr(db, pr, { types: [UPDATE_DONE] })
    .filter(row => JSON_TRUE.includes(row.data?.clean))
    .map(row => ({ from: row.data!.from as string, to: row.data!.to as string }))
}

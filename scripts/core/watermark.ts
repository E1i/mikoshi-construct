import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from './stored.js'
import { appliedOrRejected } from './rejection.js'
import { STORED_COLUMNS } from './stored.js'

export const WATERMARKS = 'projection_watermarks'

export interface IncrementalProjection {
  table: string
  folds: Record<string, Fold>
}

export function watermarkOf(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT through_event_id FROM ${WATERMARKS} WHERE projection = ?`).get(table) as { through_event_id: number } | undefined
  return Number(row?.through_event_id ?? 0)
}

export function markReduced(db: DatabaseSync, table: string, through: number): void {
  db.prepare(`
    INSERT INTO ${WATERMARKS} (projection, through_event_id) VALUES (?, ?)
    ON CONFLICT (projection) DO UPDATE SET through_event_id = excluded.through_event_id
  `).run(table, through)
}

export function reduceProjection(db: DatabaseSync, projection: IncrementalProjection): void {
  const from = watermarkOf(db, projection.table)
  const through = Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
  const types = Object.keys(projection.folds)
  const events = db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE id > ? AND id <= ? AND legacy = 0 AND type IN (${types.map(() => '?').join(', ')}) ORDER BY id`)
    .all(from, through, ...types) as unknown as StoredEvent[]
  for (const event of events)
    appliedOrRejected(db, event, projection.folds[event.type]!)
  markReduced(db, projection.table, through)
}

import type { DatabaseSync } from 'node:sqlite'
import type { StoredEvent } from './stored-event.js'
import { reject } from './stored-event.js'

export type { Fold, StoredEvent } from './stored-event.js'
export { reject, Rejection } from './stored-event.js'

export function payloadOf(event: StoredEvent): Record<string, unknown> {
  try {
    const payload = JSON.parse(event.payload) as unknown
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload))
      return payload as Record<string, unknown>
  }
  catch {}
  return reject('payload is not a JSON object')
}

export const STORED_COLUMNS = 'id, ts, type, card_id, pr, head, dedupe_key, payload'

export function storedByKey(db: DatabaseSync, dedupeKey: string): StoredEvent {
  return db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE dedupe_key = ?`).get(dedupeKey) as unknown as StoredEvent
}

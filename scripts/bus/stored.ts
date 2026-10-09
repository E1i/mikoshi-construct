import type { DatabaseSync } from 'node:sqlite'

export interface StoredEvent {
  id: number
  ts: string
  type: string
  card_id: number | null
  pr: number | null
  head: string | null
  dedupe_key: string
  payload: string
}

export type Fold = (db: DatabaseSync, event: StoredEvent) => void

export class Rejection extends Error {}

export function reject(reason: string): never {
  throw new Rejection(reason)
}

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

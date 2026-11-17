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

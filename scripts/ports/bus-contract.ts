import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from '../core/stored-event.js'

export interface BusEventDraft {
  ts: string | null
  type: string
  actor: string | null
  cardId: number | null
  pr: number | null
  head: string | null
  dedupeKey: string
  payload: unknown
  legacy: boolean
}

export interface BusEventsQuery {
  types?: readonly string[]
  card?: number
  pr?: number | null
  before?: number
  ids?: readonly number[]
  legacy?: boolean
  newestFirst?: boolean
  limit?: number
}

export type BusEventData = Record<string, unknown>

export interface BusEventRow extends StoredEvent {
  actor: string | null
  legacy: boolean
  data: BusEventData | null
}

export interface BusTaskRow {
  task_key: string
  state: string
  lease_gen: number
}

export interface BusProjection {
  table: string
  folds: Record<string, Fold>
}

export interface BusCardVersion {
  current: number
  key: string
  of: (payload: string | null) => number
}

export interface BusContract {
  appendEvent: (db: DatabaseSync, event: BusEventDraft) => boolean
  events: (db: DatabaseSync, query?: BusEventsQuery) => BusEventRow[]
  latest: (db: DatabaseSync, query: BusEventsQuery) => BusEventRow | null
  byId: (db: DatabaseSync, id: number) => BusEventRow | null
  ofCard: (db: DatabaseSync, card: number, query?: Omit<BusEventsQuery, 'card'>) => BusEventRow[]
  perCard: (db: DatabaseSync, query?: Omit<BusEventsQuery, 'card'>) => Map<number, BusEventRow[]>
  tasksOfCard: (db: DatabaseSync, card: number, filter?: { queue?: string }) => BusTaskRow[]
  payloadOf: (event: StoredEvent) => Record<string, unknown>
  lastEventId: (db: DatabaseSync) => number
  watermarkOf: (db: DatabaseSync, table: string) => number
  markReduced: (db: DatabaseSync, table: string, through: number) => void
  reduceProjection: (db: DatabaseSync, projection: BusProjection) => void
  openReadOnly: (file: string) => DatabaseSync
  openWait: string
  cardVersion: BusCardVersion
}

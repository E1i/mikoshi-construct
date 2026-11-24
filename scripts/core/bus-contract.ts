import type { DatabaseSync } from 'node:sqlite'

export interface BusStoredEvent {
  id: number
  ts: string
  type: string
  card_id: number | null
  pr: number | null
  head: string | null
  dedupe_key: string
  payload: string
}

export type BusFold = (db: DatabaseSync, event: BusStoredEvent) => void

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

export interface BusEventRow extends BusStoredEvent {
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
  folds: Record<string, BusFold>
}

export interface BusCardVersion {
  current: number
  of: (payload: string | null) => number
}

export interface BusLease<Q extends string = string> {
  taskKey: string
  queue: Q
  cardId: number
  pr: number | null
  head: string | null
  leaseGen: number
  actor: string
}

export interface BusCardTransitions {
  appendedOnCard: (db: DatabaseSync, event: BusEventDraft) => boolean
}

export interface BusCarriedTree {
  path: string
  head: string
  localCommits: string[]
  dirty: boolean
}

export interface BusFailure {
  reason: string
  withdraw: boolean
  tree?: BusCarriedTree
  behind?: boolean
}

export interface BusWait {
  reason: string
  until: string
}

export type BusQueued = 'queued'

export type BusAfterFailure = BusQueued | 'withdrawn' | 'stopped' | 'superseded'

export type BusNeedsUpdate = 'needs_update'

export type BusQuestionOpen = 'owner_question_open'

export interface BusOwnerAsk {
  need: 'command' | 'merge'
  text: string
  command?: string
  card?: number
  pr?: number
}

export interface BusDecisionWait {
  id: string
  text: string
}

export interface BusTaskContract<Q extends string, T> {
  assertHeld: (db: DatabaseSync, lease: BusLease<Q>) => void
  completeTask: (db: DatabaseSync, cards: BusCardTransitions, ts: string, lease: BusLease<Q>, outcome: BusEventDraft[]) => void
  waitTask: (db: DatabaseSync, cards: BusCardTransitions, ts: string, lease: BusLease<Q>, wait: BusWait, context?: BusEventDraft[]) => BusQueued
  failTask: (db: DatabaseSync, cards: BusCardTransitions, ts: string, lease: BusLease<Q>, failure: BusFailure, silentMs: number, context?: BusEventDraft[]) => BusAfterFailure
  releaseTask: (db: DatabaseSync, cards: BusCardTransitions, ts: string, lease: BusLease<Q>, reason: string, context?: BusEventDraft[]) => void
  isStaleLease: (error: unknown) => boolean
  keyOf: (task: T) => string
  openOwnerWait: (db: DatabaseSync, closedWaits: readonly string[], ts: string, actor: string, ask: BusOwnerAsk) => string
  openDecisionWaitsOfCard: (db: DatabaseSync, cardId: number) => BusDecisionWait[]
  reviewsInFlightOn: (db: DatabaseSync, pr: number | null, head: string | null) => string[]
  widenedOnTheAdmission: (db: DatabaseSync, cardId: number, admission: number) => string[]
  messageOf: (error: unknown) => string
  queueActor: string
  needsUpdate: BusNeedsUpdate
  questionOpen: BusQuestionOpen
}

export interface BusRunContract {
  open: (file: string) => DatabaseSync
  defaultPath: () => string
  dirOf: (busPath: string) => string
  inTransaction: <R>(db: DatabaseSync, work: () => R) => R
  isLocked: (error: unknown) => boolean
  lockedText: string
  boardTimerProcess: string
}

export interface BusContract {
  appendEvent: (db: DatabaseSync, event: BusEventDraft) => boolean
  events: (db: DatabaseSync, query?: BusEventsQuery) => BusEventRow[]
  latest: (db: DatabaseSync, query: BusEventsQuery) => BusEventRow | null
  byId: (db: DatabaseSync, id: number) => BusEventRow | null
  ofCard: (db: DatabaseSync, card: number, query?: Omit<BusEventsQuery, 'card'>) => BusEventRow[]
  perCard: (db: DatabaseSync, query?: Omit<BusEventsQuery, 'card'>) => Map<number, BusEventRow[]>
  tasksOfCard: (db: DatabaseSync, card: number, filter?: { queue?: string }) => BusTaskRow[]
  lastEventId: (db: DatabaseSync) => number
  watermarkOf: (db: DatabaseSync, table: string) => number
  markReduced: (db: DatabaseSync, table: string, through: number) => void
  reduceProjection: (db: DatabaseSync, projection: BusProjection) => void
  openReadOnly: (file: string) => DatabaseSync
  openWait: string
  cardVersion: BusCardVersion
}

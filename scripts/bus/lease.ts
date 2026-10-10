import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Queue } from './identifiers.js'
import type { Fold, StoredEvent } from './stored.js'
import { appendEvent, inTransaction } from './db.js'
import { CARD_STOPPED } from './inbox.js'
import { generationOfKey } from './identifiers.js'
import { generationField, identityOf, LEASED, QUEUE_ACTOR, QUEUED } from './queue.js'
import { payloadOf, reject, storedByKey } from './stored.js'

export const TASK_LEASED = 'task.leased'
export const TASK_RENEWED = 'task.renewed'
export const TASK_COMPLETED = 'task.completed'
export const TASK_FAILED = 'task.failed'
export const TASK_EXPIRED = 'task.expired'
export const TASK_RELEASED = 'task.released'
export const BOARD_ALARM = 'board.alarm'

export const LEASE_MS = 30 * 60_000
export const FAILURES_TO_STOP = 3

export const COMPLETED = 'completed'
export const WITHDRAWN = 'withdrawn'
export const STOPPED = 'stopped'

const NEXT_STATES = new Set([QUEUED, WITHDRAWN, STOPPED])

export class StaleLease extends Error {}

export interface Lease {
  taskKey: string
  queue: Queue
  cardId: number
  pr: number | null
  head: string | null
  leaseGen: number
  actor: string
}

export interface Failure {
  reason: string
  withdraw: boolean
}

export type AfterFailure = typeof QUEUED | typeof WITHDRAWN | typeof STOPPED

interface LeaseRow {
  id: number
  task_key: string
  queue: Queue
  card_id: number
  pr: number | null
  head: string | null
  state: string
  lease_gen: number
  lease_until: string | null
  failures: number
}

const NEXT_LEASABLE = `
  SELECT tasks.* FROM tasks LEFT JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = ? AND tasks.state = '${QUEUED}' AND (tasks.pr IS NULL OR (prs.state = 'open' AND prs.head = tasks.head))
  ORDER BY tasks.id LIMIT 1
`

const LAPSED = `SELECT * FROM tasks WHERE state = '${LEASED}' AND lease_until < ? ORDER BY id`

function rowOf(db: DatabaseSync, key: string): LeaseRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE task_key = ?').get(key) as LeaseRow | undefined
}

function leaseUntil(ts: string): string {
  return new Date(Date.parse(ts) + LEASE_MS).toISOString()
}

function generationOf(payload: Record<string, unknown>): number {
  const value = payload.lease_gen
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : reject('lease_gen is not a positive integer')
}

function heldRow(db: DatabaseSync, event: StoredEvent): { row: LeaseRow, payload: Record<string, unknown> } {
  const { key } = identityOf(event)
  const payload = payloadOf(event)
  const row = rowOf(db, key) ?? reject(`task ${key} was never queued`)
  if (row.state !== LEASED || row.lease_gen !== generationOf(payload))
    reject(`task ${key} is not leased under lease_gen ${String(payload.lease_gen)}`)
  return { row, payload }
}

function foldLeased(db: DatabaseSync, event: StoredEvent): void {
  const { key } = identityOf(event)
  const payload = payloadOf(event)
  const row = rowOf(db, key) ?? reject(`task ${key} was never queued`)
  if (row.state !== QUEUED)
    reject(`task ${key} is ${row.state}, not queued`)
  if (generationOf(payload) !== row.lease_gen + 1)
    reject(`lease_gen ${String(payload.lease_gen)} does not follow ${row.lease_gen}`)
  db.prepare('UPDATE tasks SET state = ?, lease_gen = ?, lease_until = ?, event_id = ? WHERE task_key = ?')
    .run(LEASED, row.lease_gen + 1, leaseUntil(event.ts), event.id, key)
}

function foldRenewed(db: DatabaseSync, event: StoredEvent): void {
  const { row } = heldRow(db, event)
  db.prepare('UPDATE tasks SET lease_until = ?, event_id = ? WHERE task_key = ?').run(leaseUntil(event.ts), event.id, row.task_key)
}

function foldCompleted(db: DatabaseSync, event: StoredEvent): void {
  const { row } = heldRow(db, event)
  db.prepare('UPDATE tasks SET state = ?, lease_until = NULL, event_id = ? WHERE task_key = ?').run(COMPLETED, event.id, row.task_key)
}

function foldFailed(db: DatabaseSync, event: StoredEvent): void {
  const { row, payload } = heldRow(db, event)
  const next = typeof payload.next === 'string' && NEXT_STATES.has(payload.next) ? payload.next : reject(`next is not one of ${[...NEXT_STATES].join(' | ')}`)
  db.prepare('UPDATE tasks SET state = ?, lease_until = NULL, failures = failures + 1, event_id = ? WHERE task_key = ?').run(next, event.id, row.task_key)
}

function foldReleased(db: DatabaseSync, event: StoredEvent): void {
  const { row } = heldRow(db, event)
  db.prepare('UPDATE tasks SET state = ?, lease_until = NULL, event_id = ? WHERE task_key = ?').run(QUEUED, event.id, row.task_key)
}

export const LEASE_FOLDS: Record<string, Fold> = {
  [TASK_RELEASED]: foldReleased,
  [TASK_LEASED]: foldLeased,
  [TASK_RENEWED]: foldRenewed,
  [TASK_COMPLETED]: foldCompleted,
  [TASK_FAILED]: foldFailed,
  [TASK_EXPIRED]: foldFailed,
}

function leaseOf(row: LeaseRow, actor: string): Lease {
  return { taskKey: row.task_key, queue: row.queue, cardId: row.card_id, pr: row.pr, head: row.head, leaseGen: row.lease_gen, actor }
}

function taskEvent(ts: string, type: string, actor: string, row: LeaseRow, leaseGen: number, dedupeKey: string, fields: object = {}): BusEvent {
  const generation = generationOfKey(row.task_key, { queue: row.queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined })
  return { ts, type, actor, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey, payload: { task_key: row.task_key, queue: row.queue, ...generationField(generation), lease_gen: leaseGen, ...fields }, legacy: false }
}

function folded(db: DatabaseSync, event: BusEvent): void {
  if (appendEvent(db, event))
    LEASE_FOLDS[event.type]!(db, storedByKey(db, event.dedupeKey))
}

function held(db: DatabaseSync, lease: Lease): LeaseRow {
  const row = rowOf(db, lease.taskKey)
  if (row === undefined || row.state !== LEASED || row.lease_gen !== lease.leaseGen)
    throw new StaleLease(`task ${lease.taskKey} is no longer leased under lease_gen ${lease.leaseGen}`)
  return row
}

export function assertHeld(db: DatabaseSync, lease: Lease): void {
  held(db, lease)
}

export function leaseNext(db: DatabaseSync, ts: string, queue: Queue, actor: string): Lease | null {
  return inTransaction(db, () => {
    const row = db.prepare(NEXT_LEASABLE).get(queue) as LeaseRow | undefined
    if (row === undefined)
      return null
    const leaseGen = row.lease_gen + 1
    folded(db, taskEvent(ts, TASK_LEASED, actor, row, leaseGen, `${TASK_LEASED}:${row.task_key}:${leaseGen}`))
    return leaseOf(rowOf(db, row.task_key)!, actor)
  })
}

export function renewLease(db: DatabaseSync, ts: string, lease: Lease): void {
  inTransaction(db, () => {
    const row = held(db, lease)
    folded(db, taskEvent(ts, TASK_RENEWED, lease.actor, row, lease.leaseGen, `${TASK_RENEWED}:${row.task_key}:${lease.leaseGen}:${ts}`))
  })
}

export function completeTask(db: DatabaseSync, ts: string, lease: Lease, outcome: BusEvent[], stillDue: () => boolean = () => true): void {
  inTransaction(db, () => {
    const row = held(db, lease)
    if (!stillDue())
      throw new StaleLease(`task ${lease.taskKey} is no longer due`)
    for (const event of outcome)
      appendEvent(db, event)
    folded(db, taskEvent(ts, TASK_COMPLETED, lease.actor, row, lease.leaseGen, `${TASK_COMPLETED}:${row.task_key}:${lease.leaseGen}`))
  })
}

function afterFailure(row: LeaseRow, failure: Failure): AfterFailure {
  if (failure.withdraw)
    return WITHDRAWN
  return row.failures + 1 >= FAILURES_TO_STOP ? STOPPED : QUEUED
}

function failed(db: DatabaseSync, ts: string, type: string, actor: string, row: LeaseRow, failure: Failure, context: BusEvent[]): AfterFailure {
  const next = afterFailure(row, failure)
  for (const event of context)
    appendEvent(db, event)
  folded(db, taskEvent(ts, type, actor, row, row.lease_gen, `${type}:${row.task_key}:${row.lease_gen}`, { reason: failure.reason, next }))
  if (next === STOPPED) {
    const detail = `${FAILURES_TO_STOP} failures in a row on ${row.task_key}, the last: ${failure.reason}`
    appendEvent(db, { ts, type: CARD_STOPPED, actor, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey: `${CARD_STOPPED}:${row.task_key}`, payload: { reason: 'fault', detail }, legacy: false })
    appendEvent(db, { ts, type: BOARD_ALARM, actor: QUEUE_ACTOR, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey: `${BOARD_ALARM}:${row.task_key}`, payload: { task_key: row.task_key, reason: 'fault', failures: row.failures + 1, detail }, legacy: false })
  }
  return next
}

export function failTask(db: DatabaseSync, ts: string, lease: Lease, failure: Failure, context: BusEvent[] = []): AfterFailure {
  return inTransaction(db, () => failed(db, ts, TASK_FAILED, lease.actor, held(db, lease), failure, context))
}

export function releaseTask(db: DatabaseSync, ts: string, lease: Lease, reason: string, context: BusEvent[] = []): void {
  inTransaction(db, () => {
    const row = held(db, lease)
    for (const event of context)
      appendEvent(db, event)
    folded(db, taskEvent(ts, TASK_RELEASED, lease.actor, row, row.lease_gen, `${TASK_RELEASED}:${row.task_key}:${row.lease_gen}`, { reason }))
  })
}

export function expireLeases(db: DatabaseSync, ts: string): string[] {
  return inTransaction(db, () => {
    const lapsed = db.prepare(LAPSED).all(ts) as unknown as LeaseRow[]
    for (const row of lapsed)
      failed(db, ts, TASK_EXPIRED, QUEUE_ACTOR, row, { reason: 'lease_expired', withdraw: false }, [])
    return lapsed.map(row => row.task_key)
  })
}

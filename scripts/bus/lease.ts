import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Queue, TaskIdentity } from './identifiers.js'
import { BOARD_ALARM, CARD_STOPPED, LEASES_DRAINING, RESTARTED, TASK_COMPLETED, TASK_EXPIRED, TASK_FAILED, TASK_LEASED, TASK_RELEASED, TASK_RENEWED, TASK_SUPERSEDED } from '../core/events.js'
import { appendedOnCard } from './card-automaton.js'
import { appendEvent, inTransaction } from './db.js'
import { generationOfKey, taskKey } from './identifiers.js'
import { appendedAndReduced, FAILURES_TO_STOP, generationField, LEASED, QUEUE_ACTOR, QUEUED, queueTaskWithin, STOPPED, WITHDRAWN } from './queue.js'
import { reject } from './stored.js'

export { HEARTBEAT_QUEUES, LEASE_FOLDS, LEASE_MS } from './queue.js'

export const RENEW_MS = 10 * 60_000
export const LEASE_EXPIRED = 'lease_expired'

const REQUEUED_TO_THE_BACK: Queue = 'review'

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

export const SUPERSEDED_LEASE = 'superseded'

export type AfterFailure = typeof QUEUED | typeof WITHDRAWN | typeof STOPPED | typeof SUPERSEDED_LEASE

const STALE_HEAD = 'stale_head'

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
  event_id: number
}

const LEASABLE_FROM = `
  FROM tasks LEFT JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = ? AND tasks.state = '${QUEUED}' AND (tasks.pr IS NULL OR (prs.state = ? AND prs.head = tasks.head))
`

const GRANT_ORDER = `ORDER BY tasks.card_id IN (SELECT value FROM json_each(?)) DESC, CASE WHEN tasks.queue = '${REQUEUED_TO_THE_BACK}' THEN tasks.event_id ELSE tasks.id END`

const HELD_CARD = `EXISTS (SELECT 1 FROM tasks AS held WHERE held.queue = tasks.queue AND held.state = '${LEASED}' AND held.card_id = tasks.card_id)`

const NEXT_LEASABLE = `
  SELECT tasks.* ${LEASABLE_FROM}
    AND NOT (? AND ${HELD_CARD})
  ${GRANT_ORDER} LIMIT 1
`

const LEASABLE_IN_GRANT_ORDER = `SELECT tasks.task_key, tasks.card_id, ${HELD_CARD} AS held ${LEASABLE_FROM} ${GRANT_ORDER}`

const QUEUED_CARDS = `SELECT DISTINCT card_id FROM tasks WHERE queue = ? AND state = '${QUEUED}' ORDER BY card_id`

export interface LeaseOrder {
  onePerCard: boolean
  firstCards: readonly number[]
}

const IN_ARRIVAL_ORDER: LeaseOrder = { onePerCard: false, firstCards: [] }

const PR_STATE_OF_QUEUE: Partial<Record<Queue, string>> = { close: 'merged' }

const UPDATE_DERIVED_FOR_BEHIND = `
  SELECT 1 FROM prs JOIN tasks ON tasks.pr = prs.pr AND tasks.head = prs.head
  WHERE prs.pr = ? AND prs.head = ? AND prs.mergeable = 'behind' AND tasks.queue = 'update' AND tasks.state IN ('${QUEUED}', '${LEASED}')
`

const LAPSED = `SELECT * FROM tasks WHERE state = '${LEASED}' AND lease_until < ? ORDER BY id`

const HELD_BY_KIND = `
  SELECT tasks.* FROM tasks JOIN events ON events.dedupe_key = '${TASK_LEASED}:' || tasks.task_key || ':' || tasks.lease_gen
  WHERE tasks.state = '${LEASED}' AND events.actor LIKE ? ORDER BY tasks.id
`

const LAST_DRAIN_SINCE_RESTART = `
  SELECT payload FROM events WHERE type = '${LEASES_DRAINING}'
    AND id > (SELECT coalesce(max(id), 0) FROM events WHERE type = '${RESTARTED}')
  ORDER BY id DESC LIMIT 1
`

function rowOf(db: DatabaseSync, key: string): LeaseRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE task_key = ?').get(key) as LeaseRow | undefined
}

function leaseOf(row: LeaseRow, actor: string): Lease {
  return { taskKey: row.task_key, queue: row.queue, cardId: row.card_id, pr: row.pr, head: row.head, leaseGen: row.lease_gen, actor }
}

function taskEvent(ts: string, type: string, actor: string, row: LeaseRow, leaseGen: number, dedupeKey: string, fields: object = {}): BusEvent {
  const generation = generationOfKey(row.task_key, { queue: row.queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined })
  return { ts, type, actor, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey, payload: { task_key: row.task_key, queue: row.queue, ...generationField(generation), lease_gen: leaseGen, ...fields }, legacy: false }
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

export function queuedCards(db: DatabaseSync, queue: Queue): number[] {
  return (db.prepare(QUEUED_CARDS).all(queue) as { card_id: number }[]).map(row => Number(row.card_id))
}

export function leaseNext(db: DatabaseSync, ts: string, queue: Queue, actor: string, order: LeaseOrder = IN_ARRIVAL_ORDER): Lease | null {
  return inTransaction(db, () => {
    const row = db.prepare(NEXT_LEASABLE).get(queue, PR_STATE_OF_QUEUE[queue] ?? 'open', order.onePerCard ? 1 : 0, JSON.stringify(order.firstCards)) as LeaseRow | undefined
    return row === undefined ? null : leased(db, ts, row, actor)
  })
}

export function leaseQueued(db: DatabaseSync, ts: string, key: string, actor: string): Lease | null {
  return inTransaction(db, () => {
    const row = rowOf(db, key)
    return row?.state === QUEUED ? leased(db, ts, row, actor) : null
  })
}

export interface Waiting {
  taskKey: string
  cardId: number
}

export function grantOrder(db: DatabaseSync, queue: Queue, order: LeaseOrder = IN_ARRIVAL_ORDER): Waiting[] {
  const rows = db.prepare(LEASABLE_IN_GRANT_ORDER).all(queue, PR_STATE_OF_QUEUE[queue] ?? 'open', JSON.stringify(order.firstCards)) as { task_key: string, card_id: number, held: number }[]
  const granted = new Set<number>()
  const now: Waiting[] = []
  const later: Waiting[] = []
  for (const row of rows) {
    const waits = order.onePerCard && (row.held === 1 || granted.has(row.card_id))
    granted.add(row.card_id)
    if (waits)
      later.push({ taskKey: row.task_key, cardId: row.card_id })
    else
      now.push({ taskKey: row.task_key, cardId: row.card_id })
  }
  return [...now, ...later]
}

function leased(db: DatabaseSync, ts: string, row: LeaseRow, actor: string): Lease {
  const leaseGen = row.lease_gen + 1
  appendedAndReduced(db, taskEvent(ts, TASK_LEASED, actor, row, leaseGen, `${TASK_LEASED}:${row.task_key}:${leaseGen}`))
  return leaseOf(rowOf(db, row.task_key)!, actor)
}

export function leasedCount(db: DatabaseSync, queue: Queue): number {
  return Number((db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = ? AND state = '${LEASED}'`).get(queue) as { n: number }).n)
}

export function leaseWhileFree(db: DatabaseSync, ts: string, task: TaskIdentity, actor: string, slots: number): Lease | null {
  return inTransaction(db, () => {
    if (leasedCount(db, task.queue) >= slots)
      return null
    queueTaskWithin(db, ts, task)
    const row = rowOf(db, taskKey(task)) ?? reject(`task ${taskKey(task)} was never queued`)
    return row.state === QUEUED ? leased(db, ts, row, actor) : null
  })
}

export function renewLease(db: DatabaseSync, ts: string, lease: Lease): void {
  inTransaction(db, () => {
    const row = held(db, lease)
    appendedAndReduced(db, taskEvent(ts, TASK_RENEWED, lease.actor, row, lease.leaseGen, `${TASK_RENEWED}:${row.task_key}:${lease.leaseGen}:${ts}`))
  })
}

export function completeTask(db: DatabaseSync, ts: string, lease: Lease, outcome: BusEvent[], stillDue: (db: DatabaseSync) => void = () => {}): void {
  inTransaction(db, () => {
    const row = held(db, lease)
    stillDue(db)
    for (const event of outcome)
      appendedOnCard(db, event)
    appendedAndReduced(db, taskEvent(ts, TASK_COMPLETED, lease.actor, row, lease.leaseGen, `${TASK_COMPLETED}:${row.task_key}:${lease.leaseGen}`))
  })
}

function waitsForTheHead(db: DatabaseSync, row: LeaseRow, failure: Failure): boolean {
  return failure.reason === 'not_mergeable' && row.pr !== null && db.prepare(UPDATE_DERIVED_FOR_BEHIND).get(row.pr, row.head) !== undefined
}

function afterFailure(row: LeaseRow, failure: Failure, uncounted: boolean): AfterFailure {
  if (failure.withdraw)
    return WITHDRAWN
  return !uncounted && row.failures + 1 >= FAILURES_TO_STOP ? STOPPED : QUEUED
}

function failed(db: DatabaseSync, ts: string, type: string, actor: string, row: LeaseRow, failure: Failure, context: BusEvent[]): AfterFailure {
  const uncounted = waitsForTheHead(db, row, failure)
  const next = afterFailure(row, failure, uncounted)
  for (const event of context)
    appendedOnCard(db, event)
  appendedAndReduced(db, taskEvent(ts, type, actor, row, row.lease_gen, `${type}:${row.task_key}:${row.lease_gen}`, { reason: failure.reason, next, ...(uncounted ? { uncounted } : {}) }))
  if (next === STOPPED) {
    const detail = `${FAILURES_TO_STOP} failures in a row on ${row.task_key}, the last: ${failure.reason}`
    appendedOnCard(db, { ts, type: CARD_STOPPED, actor, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey: `${CARD_STOPPED}:${row.task_key}`, payload: { reason: 'fault', detail }, legacy: false })
    appendEvent(db, { ts, type: BOARD_ALARM, actor: QUEUE_ACTOR, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey: `${BOARD_ALARM}:${row.task_key}`, payload: { task_key: row.task_key, reason: 'fault', failures: row.failures + 1, detail }, legacy: false })
  }
  return next
}

export function failTask(db: DatabaseSync, ts: string, lease: Lease, failure: Failure, context: BusEvent[] = []): AfterFailure {
  if (failure.reason === STALE_HEAD && !failure.withdraw)
    return supersedeLease(db, ts, lease, context)
  return inTransaction(db, () => failed(db, ts, TASK_FAILED, lease.actor, held(db, lease), failure, context))
}

export function releaseTask(db: DatabaseSync, ts: string, lease: Lease, reason: string, context: BusEvent[] = []): void {
  inTransaction(db, () => {
    const row = held(db, lease)
    for (const event of context)
      appendedOnCard(db, event)
    appendedAndReduced(db, taskEvent(ts, TASK_RELEASED, lease.actor, row, row.lease_gen, `${TASK_RELEASED}:${row.task_key}:${row.lease_gen}`, { reason }))
  })
}

export function supersedeLease(db: DatabaseSync, ts: string, lease: Lease, context: BusEvent[] = []): typeof SUPERSEDED_LEASE {
  return inTransaction(db, () => {
    const row = held(db, lease)
    for (const event of context)
      appendedOnCard(db, event)
    appendedAndReduced(db, taskEvent(ts, TASK_SUPERSEDED, lease.actor, row, row.lease_gen, `${TASK_SUPERSEDED}:${row.task_key}:after-${row.event_id}`))
    return SUPERSEDED_LEASE
  })
}

function expired(db: DatabaseSync, ts: string, rows: LeaseRow[], reason: string): string[] {
  for (const row of rows)
    failed(db, ts, TASK_EXPIRED, QUEUE_ACTOR, row, { reason, withdraw: false }, [])
  return rows.map(row => row.task_key)
}

export function expireLeases(db: DatabaseSync, ts: string): string[] {
  return inTransaction(db, () => expired(db, ts, db.prepare(LAPSED).all(ts) as unknown as LeaseRow[], LEASE_EXPIRED))
}

function heldBy(db: DatabaseSync, workerKinds: readonly string[]): LeaseRow[] {
  return workerKinds.flatMap(kind => db.prepare(HELD_BY_KIND).all(`worker:${kind}:%`) as unknown as LeaseRow[])
}

export function leasesHeldBy(db: DatabaseSync, workerKinds: readonly string[]): string[] {
  return heldBy(db, workerKinds).map(row => row.task_key)
}

export function expireLeasesHeldBy(db: DatabaseSync, ts: string, workerKinds: readonly string[]): string[] {
  return inTransaction(db, () => expired(db, ts, heldBy(db, workerKinds), 'holder_stopped'))
}

export function openDrain(db: DatabaseSync, ts: string, sha: string, until: string): void {
  appendEvent(db, { ts, type: LEASES_DRAINING, actor: QUEUE_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${LEASES_DRAINING}:${sha}:${until}`, payload: { sha, until }, legacy: false })
}

export function drainOpen(db: DatabaseSync, ts: string): boolean {
  const row = db.prepare(LAST_DRAIN_SINCE_RESTART).get() as { payload: string } | undefined
  if (row === undefined)
    return false
  const until = (JSON.parse(row.payload) as { until?: unknown }).until
  return typeof until === 'string' && until > ts
}

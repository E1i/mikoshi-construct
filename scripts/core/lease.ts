import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Queue, TaskIdentity } from './identifiers.js'
import { RateLimited } from '../ports/meter.js'
import { SILENT_MS } from '../supervisor/liveness-sites.js'
import { appendedOnCard } from './card-automaton.js'
import { appendEvent, inTransaction } from './db.js'
import { BOARD_ALARM, CARD_STOPPED, LEASES_DRAINING, RESTARTED, SESSION_HEARTBEAT, TASK_COMPLETED, TASK_EXPIRED, TASK_FAILED, TASK_LEASED, TASK_RELEASED, TASK_RENEWED, TASK_SUPERSEDED, WORKER_STARTED } from './events.js'
import { generationOfKey, taskKey } from './identifiers.js'
import { appendedAndReduced, FAILURES_TO_STOP, generationField, LEASE_MS, LEASED, QUEUE_ACTOR, QUEUED, queueTaskWithin, STOPPED, WITHDRAWN } from './queue.js'
import { reject } from './stored.js'

export { SESSION_HELD_QUEUES as HEARTBEAT_QUEUES, LEASE_FOLDS, LEASE_MS } from './queue.js'

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

export interface Wait {
  reason: string
  until: string
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

const WAITING_UNTIL_LATER = `EXISTS (
  SELECT 1 FROM events AS waited WHERE waited.id = tasks.event_id AND waited.type = '${TASK_RELEASED}' AND json_extract(waited.payload, '$.until') > ?
)`

const NEXT_LEASABLE = `
  SELECT tasks.* ${LEASABLE_FROM}
    AND NOT (? AND ${HELD_CARD}) AND NOT ${WAITING_UNTIL_LATER}
  ${GRANT_ORDER} LIMIT 1
`

const LAST_BEAT_OF_THE_TASK = `
  SELECT max(ts) AS ts FROM events
  WHERE type = '${SESSION_HEARTBEAT}' AND legacy = 0 AND card_id = ?
    AND (json_extract(payload, '$.task_key') = ? OR (json_type(payload, '$.task_key') IS NULL AND ?))
`

const QUEUES_THAT_RUN_A_CARD_SESSION: ReadonlySet<Queue> = new Set(['answer', 'launch'])

const STATUS_MARK = 111
const SECONDS_MARK = 222222

function retryAfterPattern(): RegExp {
  const message = new RateLimited(STATUS_MARK, SECONDS_MARK).message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(message.replace(String(SECONDS_MARK), '(\\d+)').replace(String(STATUS_MARK), '\\d+'))
}

const RETRY_AFTER = retryAfterPattern()

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
    AND coalesce(json_extract(payload, '$.node'), ?) = ?
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
    const row = db.prepare(NEXT_LEASABLE).get(queue, PR_STATE_OF_QUEUE[queue] ?? 'open', order.onePerCard ? 1 : 0, ts, JSON.stringify(order.firstCards)) as LeaseRow | undefined
    return row === undefined ? null : leased(db, ts, row, actor)
  })
}

function waitsPast(db: DatabaseSync, key: string, ts: string): boolean {
  return db.prepare(`SELECT 1 FROM tasks WHERE task_key = ? AND ${WAITING_UNTIL_LATER}`).get(key, ts) !== undefined
}

export function leaseQueued(db: DatabaseSync, ts: string, key: string, actor: string): Lease | null {
  return inTransaction(db, () => {
    const row = rowOf(db, key)
    return row?.state === QUEUED && !waitsPast(db, key, ts) ? leased(db, ts, row, actor) : null
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

export function leasedOn(db: DatabaseSync, queue: Queue, pr: number): boolean {
  return db.prepare(`SELECT 1 FROM tasks WHERE queue = ? AND pr = ? AND state = '${LEASED}' LIMIT 1`).get(queue, pr) !== undefined
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

function freshBeatUntil(db: DatabaseSync, ts: string, row: LeaseRow): string | null {
  const cardSessionBeats = QUEUES_THAT_RUN_A_CARD_SESSION.has(row.queue) ? 1 : 0
  const beat = (db.prepare(LAST_BEAT_OF_THE_TASK).get(row.card_id, row.task_key, cardSessionBeats) as { ts: string | null }).ts
  if (beat === null)
    return null
  const until = new Date(Date.parse(beat) + SILENT_MS).toISOString()
  return until > ts ? until : null
}

function waited(db: DatabaseSync, ts: string, actor: string, row: LeaseRow, wait: Wait, context: BusEvent[]): typeof QUEUED {
  for (const event of context)
    appendedOnCard(db, event)
  appendedAndReduced(db, taskEvent(ts, TASK_RELEASED, actor, row, row.lease_gen, `${TASK_RELEASED}:${row.task_key}:${row.lease_gen}`, { reason: wait.reason, until: wait.until }))
  return QUEUED
}

export function waitTask(db: DatabaseSync, ts: string, lease: Lease, wait: Wait, context: BusEvent[] = []): typeof QUEUED {
  return inTransaction(db, () => waited(db, ts, lease.actor, held(db, lease), wait, context))
}

function failed(db: DatabaseSync, ts: string, type: string, actor: string, row: LeaseRow, failure: Failure, context: BusEvent[]): AfterFailure {
  const uncounted = waitsForTheHead(db, row, failure)
  const next = afterFailure(row, failure, uncounted)
  const beating = next === STOPPED ? freshBeatUntil(db, ts, row) : null
  if (beating !== null)
    return waited(db, ts, actor, row, { reason: failure.reason, until: beating }, context)
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

function retryAfterIn(ts: string, context: readonly BusEvent[]): string | null {
  for (const event of context) {
    const detail = (event.payload as Record<string, unknown> | null)?.detail
    const match = typeof detail === 'string' ? RETRY_AFTER.exec(detail) : null
    if (match !== null)
      return new Date(Date.parse(ts) + Number(match[1]) * 1000).toISOString()
  }
  return null
}

export function failTask(db: DatabaseSync, ts: string, lease: Lease, failure: Failure, context: BusEvent[] = []): AfterFailure {
  if (failure.reason === STALE_HEAD && !failure.withdraw)
    return supersedeLease(db, ts, lease, context)
  const rateLimitedUntil = failure.withdraw ? null : retryAfterIn(ts, context)
  if (rateLimitedUntil !== null)
    return waitTask(db, ts, lease, { reason: failure.reason, until: rateLimitedUntil }, context)
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

export const HOLDER_DEAD = 'holder_dead'
export const WORKER_HUNG = 'worker_hung'
export const HOLDER_UNPROVEN = 'holder_unproven'
export const SAME_START_MS = 2_000

export interface HolderStart {
  pid: number
  started: string
}

export type HolderProcess = { state: 'gone' } | { state: 'running', started: string } | { state: 'unreadable' }

export type ProcessStartOf = (pid: number) => HolderProcess

export interface HolderReading {
  freed: string[]
  hung: string[]
  unproven: string[]
}

type HolderVerdict = 'dead' | 'alive' | 'unproven'

interface HeldWithHolder {
  task_key: string
  card_id: number
  pr: number | null
  head: string | null
  lease_gen: number
  lease_until: string
  holder: string
  start: string | null
}

const LEASES_WITH_THEIR_HOLDER = `
  SELECT tasks.task_key, tasks.card_id, tasks.pr, tasks.head, tasks.lease_gen, tasks.lease_until, leased.actor AS holder,
    (SELECT started.payload FROM events AS started WHERE started.type = '${WORKER_STARTED}' AND started.actor = leased.actor ORDER BY started.id DESC LIMIT 1) AS start
  FROM tasks JOIN events AS leased ON leased.dedupe_key = '${TASK_LEASED}:' || tasks.task_key || ':' || tasks.lease_gen
  WHERE tasks.state = '${LEASED}' ORDER BY tasks.id
`

export function recordWorkerStarted(db: DatabaseSync, ts: string, worker: string, start: HolderStart): boolean {
  return appendEvent(db, { ts, type: WORKER_STARTED, actor: worker, cardId: null, pr: null, head: null, dedupeKey: `${WORKER_STARTED}:${worker}`, payload: { worker, pid: start.pid, started: start.started }, legacy: false })
}

function recordedStart(payload: string | null): HolderStart | null {
  if (payload === null)
    return null
  const { pid, started } = JSON.parse(payload) as { pid?: unknown, started?: unknown }
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && typeof started === 'string' && !Number.isNaN(Date.parse(started)) ? { pid, started } : null
}

function sameStart(recorded: string, running: string): boolean {
  return Math.abs(Date.parse(recorded) - Date.parse(running)) < SAME_START_MS
}

function verdictOn(start: HolderStart | null, startOf: ProcessStartOf): HolderVerdict {
  if (start === null)
    return 'unproven'
  const running = startOf(start.pid)
  if (running.state === 'unreadable')
    return 'unproven'
  return running.state === 'running' && sameStart(start.started, running.started) ? 'alive' : 'dead'
}

function silentSince(row: HeldWithHolder, ts: string): boolean {
  return Date.parse(row.lease_until) - LEASE_MS + SILENT_MS < Date.parse(ts)
}

function releasedFromTheDead(db: DatabaseSync, ts: string, row: HeldWithHolder): boolean {
  return inTransaction(db, () => {
    const current = rowOf(db, row.task_key)
    if (current === undefined || current.state !== LEASED || current.lease_gen !== row.lease_gen)
      return false
    failed(db, ts, TASK_EXPIRED, QUEUE_ACTOR, current, { reason: HOLDER_DEAD, withdraw: false }, [])
    return true
  })
}

function holderAlarm(db: DatabaseSync, ts: string, row: HeldWithHolder, reason: typeof WORKER_HUNG | typeof HOLDER_UNPROVEN, detail: string): boolean {
  return appendEvent(db, { ts, type: BOARD_ALARM, actor: QUEUE_ACTOR, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey: `${BOARD_ALARM}:${reason}:${row.task_key}:${row.lease_gen}`, payload: { reason, lease: row.task_key, lease_gen: row.lease_gen, worker: row.holder, detail }, legacy: false })
}

export function judgeHolders(db: DatabaseSync, ts: string, startOf: ProcessStartOf): HolderReading {
  const reading: HolderReading = { freed: [], hung: [], unproven: [] }
  for (const row of db.prepare(LEASES_WITH_THEIR_HOLDER).all() as unknown as HeldWithHolder[]) {
    const start = recordedStart(row.start)
    const verdict = verdictOn(start, startOf)
    if (verdict === 'dead' && releasedFromTheDead(db, ts, row))
      reading.freed.push(row.task_key)
    if (verdict === 'alive' && silentSince(row, ts) && holderAlarm(db, ts, row, WORKER_HUNG, `${row.holder} (pid ${start!.pid}) is running and has not renewed ${row.task_key} for ${SILENT_MS / 60_000} min; the lease stays with it`))
      reading.hung.push(row.task_key)
    if (verdict === 'unproven' && silentSince(row, ts) && holderAlarm(db, ts, row, HOLDER_UNPROVEN, `${row.holder} holds ${row.task_key} with ${start === null ? 'no worker.started record' : `pid ${start.pid} unreadable`}; whether it is alive cannot be proven, so the lease is not freed`))
      reading.unproven.push(row.task_key)
  }
  return reading
}

export function openDrain(db: DatabaseSync, ts: string, sha: string, until: string, node: string): void {
  appendEvent(db, { ts, type: LEASES_DRAINING, actor: QUEUE_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${LEASES_DRAINING}:${node}:${sha}:${until}`, payload: { sha, until, node }, legacy: false })
}

export function closeDrain(db: DatabaseSync, ts: string, sha: string, node: string): void {
  openDrain(db, ts, sha, ts, node)
}

export function drainOpen(db: DatabaseSync, ts: string, node: string): boolean {
  const row = db.prepare(LAST_DRAIN_SINCE_RESTART).get(node, node) as { payload: string } | undefined
  if (row === undefined)
    return false
  const until = (JSON.parse(row.payload) as { until?: unknown }).until
  return typeof until === 'string' && until > ts
}

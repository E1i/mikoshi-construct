import type { DatabaseSync } from 'node:sqlite'
import type { Handover } from './executor-holds.js'
import type { HeldLease, HolderStart, Lease, LeaseOrder } from './lease.js'
import type { ChildEnd, ChildStart, InstanceOf, ProcessIdentity, WorkerIdentity } from './node.js'
import type { StoredEvent } from './stored.js'
import { appendEvent } from './db.js'
import { CHILD_ENDED, CHILD_STARTED, WORKER_STARTED } from './events.js'
import { CARD_TREE_KINDS, INLINE_QUEUES } from './executor-holds.js'
import { leaseNext, releaseHeld, sameStart } from './lease.js'
import { payloadOf } from './stored.js'

export const RETIRED_UNSTARTED = 'retired_unstarted'
export const INSTANCE_VARIABLE = 'BUS_INSTANCE'
export const GENERATION_VARIABLE = 'BUS_GENERATION'
export const UNHANDED = 'unhanded'

type LeasedQueue = Parameters<typeof leaseNext>[2]

export type EventsOf = (pattern: readonly string[]) => readonly StoredEvent[]

export interface RegisteredExecutor {
  mode: string
  instance: string
  pid: number
  lstart: string
  kind: string
  taskKey: string
  tree: string | null
}

export type ExecutorAlive = (executor: RegisteredExecutor) => boolean

export type StartReader = (pid: number) => { lstart: string } | null

const KEY_SEPARATOR = ':'

export function instanceOf(env: NodeJS.ProcessEnv): InstanceOf {
  const handed = (name: string): string => {
    const value = env[name]
    return value === undefined || value === '' ? UNHANDED : value
  }
  return { instance: handed(INSTANCE_VARIABLE), generation: handed(GENERATION_VARIABLE) }
}

export function provenIdentity(start: HolderStart, own: ProcessIdentity | null): { pgid: number | null, lstart: string } {
  const proven = own !== null && own.pid === start.pid ? own : null
  return { pgid: proven?.pgid ?? null, lstart: proven?.lstart ?? start.started }
}

export function recordWorkerIdentity(db: DatabaseSync, ts: string, identity: WorkerIdentity): boolean {
  const { worker, pid, started, instance, generation, pgid, lstart } = identity
  return appendEvent(db, { ts, type: WORKER_STARTED, actor: worker, cardId: null, pr: null, head: null, dedupeKey: `${WORKER_STARTED}:${worker}`, payload: { worker, pid, started, instance, generation, ...(pgid === null ? {} : { pgid }), lstart }, legacy: false })
}

export function recordChildStarted(db: DatabaseSync, ts: string, actor: string, child: ChildStart): boolean {
  const { mode, instance, generation, pid, pgid, lstart, kind, taskKey, tree } = child
  return appendEvent(db, { ts, type: CHILD_STARTED, actor, cardId: null, pr: null, head: null, dedupeKey: `${CHILD_STARTED}:${instance}:${pid}:${lstart}${mode === 'inline' ? `:${taskKey}` : ''}`, payload: { mode, instance, generation, pid, pgid, lstart, kind, task_key: taskKey, tree }, legacy: false })
}

export function recordChildEnded(db: DatabaseSync, ts: string, actor: string, ended: ChildEnd): boolean {
  const { instance, pid, taskKey, exit, signal } = ended
  return appendEvent(db, { ts, type: CHILD_ENDED, actor, cardId: null, pr: null, head: null, dedupeKey: `${CHILD_ENDED}:${instance}:${pid}:${taskKey}`, payload: { instance, pid, task_key: taskKey, exit, signal }, legacy: false })
}

function fieldsOf(event: StoredEvent): Record<string, unknown> {
  try {
    return payloadOf(event)
  }
  catch {
    return {}
  }
}

function executorOf(fields: Record<string, unknown>): RegisteredExecutor | null {
  const { mode, instance, pid, lstart, kind, task_key: taskKey, tree } = fields
  if (typeof pid !== 'number' || typeof lstart !== 'string' || typeof taskKey !== 'string')
    return null
  return { mode: String(mode), instance: String(instance), pid, lstart, kind: String(kind), taskKey, tree: typeof tree === 'string' ? tree : null }
}

export function registeredExecutors(events: EventsOf): RegisteredExecutor[] {
  const open = new Map<string, RegisteredExecutor>()
  for (const event of events([CHILD_STARTED, CHILD_ENDED])) {
    const fields = fieldsOf(event)
    const key = JSON.stringify([fields.instance, fields.pid, fields.task_key])
    const executor = event.type === CHILD_STARTED ? executorOf(fields) : null
    if (executor === null)
      open.delete(key)
    else
      open.set(key, executor)
  }
  return [...open.values()]
}

export function aliveBy(startOf: StartReader | undefined): ExecutorAlive | undefined {
  if (startOf === undefined)
    return undefined
  return (executor) => {
    const running = startOf(executor.pid)
    return running !== null && sameStart(executor.lstart, running.lstart)
  }
}

function numberAt(taskKey: string, index: number): number[] {
  const value = Number(taskKey.split(KEY_SEPARATOR)[index])
  return Number.isSafeInteger(value) && value > 0 ? [value] : []
}

export function heldByLiveExecutors(events: EventsOf, alive: ExecutorAlive | undefined): Handover {
  const live = registeredExecutors(events).filter(executor => alive?.(executor) ?? true)
  return {
    tasks: live.map(executor => executor.taskKey),
    cards: live.filter(executor => CARD_TREE_KINDS.has(executor.kind) && executor.tree !== null).flatMap(executor => numberAt(executor.taskKey, 1)),
    prs: live.filter(executor => INLINE_QUEUES.has(executor.kind)).flatMap(executor => numberAt(executor.taskKey, 2)),
  }
}

export function prTree(pr: number | null): string | null {
  return pr === null ? null : `pr:${pr}`
}

export function leaseHandedOver(db: DatabaseSync, events: EventsOf, ts: string, queue: LeasedQueue, actor: string, order: LeaseOrder | undefined, alive: ExecutorAlive | undefined): Lease | null {
  return leaseNext(db, ts, queue, actor, order, heldByLiveExecutors(events, alive))
}

export function unstartedOf(held: readonly HeldLease[], started: readonly StoredEvent[]): string[] {
  return held.filter(lease => !started.some(event => event.id > lease.leasedAt && fieldsOf(event).task_key === lease.taskKey)).map(lease => lease.taskKey)
}

export function releaseUnstarted(db: DatabaseSync, events: EventsOf, ts: string, actor: string): string[] {
  return releaseHeld(db, ts, actor, held => unstartedOf(held, events([CHILD_STARTED])), RETIRED_UNSTARTED)
}

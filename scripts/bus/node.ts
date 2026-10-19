import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Queue } from './identifiers.js'
import type { Lease, LeaseOrder } from './lease.js'
import type { QueuedTask } from './queue.js'
import type { SlotKind } from './scheduler.js'
import type { StoredEvent } from './stored.js'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { appendEvent, inTransaction, openBus } from './db.js'
import { drainOpen, expireLeases, leaseNext, RENEW_MS, renewLease, StaleLease, TASK_LEASED } from './lease.js'
import { CHECK_MS, TICK_MS } from './netwatch.js'
import { lastEventId } from './operator-work.js'
import { keyOf, LEASED, queueTaskWithin } from './queue.js'
import { slotsOf } from './scheduler.js'
import { STORED_COLUMNS } from './stored.js'

export const NODE_DETECTED = 'node.detected'
export const NODE_EQUIVALENCE = 'node.equivalence'
export const SWITCH_FLAG = '--on'
export const LIVE_FLAG = '--live'
export const NODE_CURSORS = 'node_cursors'

const WILDCARD = '*'

export type NodeKind = Queue & SlotKind
export type EventPattern = readonly string[]
export type Unsubscribe = () => void
export type DetectionMode = 'shadow' | 'live'
export type Via = 'event' | 'tick'

export interface Scope {
  pr?: number
  cardId?: number
}

export interface IdleStep {
  kind: 'idle'
}

export interface NodeStep {
  kind: string
  taskKey?: string
}

interface DeniedStep {
  kind: 'denied'
  taskKey: string
  denial: { kind: string, reason?: string, rule?: string, detail: string }
  next: string
}

export interface NodeSnapshot {
  kind: NodeKind
  actor: string
  mode: DetectionMode
  slots: number
  cursor: number | null
  leased: string[]
  lastStep: NodeStep | null
  startedAt: string | null
}

export interface NodeContext {
  pause: (ms: number) => Promise<unknown>
  signal?: AbortSignal
}

export interface NodeParts {
  db: DatabaseSync
  clock: () => Date
  session: string
  mode: DetectionMode
  env: NodeJS.ProcessEnv
}

export interface Equivalence {
  same: string[]
  only_node: string[]
  only_derive: string[]
}

interface Subscription {
  pattern: EventPattern
  handler: (event: StoredEvent) => void
}

export class SecondSubscription extends Error {}

export class NodeRefused extends Error {}

const IDLE: IdleStep = { kind: 'idle' }

const LEASED_BY = `
  SELECT tasks.task_key FROM tasks JOIN events ON events.dedupe_key = '${TASK_LEASED}:' || tasks.task_key || ':' || tasks.lease_gen
  WHERE tasks.state = '${LEASED}' AND events.actor = ? ORDER BY tasks.id
`

export const DATABASE_LOCKED = 'database is locked'

export function isDatabaseLocked(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DATABASE_LOCKED)
}

export function prefixOf(kind: Queue): string {
  return `[bus:${kind}] `
}

export function detectionMode(argv: readonly string[]): DetectionMode {
  return argv.includes(LIVE_FLAG) ? 'live' : 'shadow'
}

function exactAndPrefixes(pattern: EventPattern): { exact: string[], prefixes: string[] } {
  const exact: string[] = []
  const prefixes: string[] = []
  for (const type of pattern) {
    const wildcard = type.indexOf(WILDCARD)
    if (type === '' || (wildcard !== -1 && wildcard !== type.length - 1) || type === WILDCARD)
      throw new Error(`an event pattern is an event type, or a type prefix ending in a trailing ${WILDCARD}: ${JSON.stringify(type)}`)
    if (wildcard === -1)
      exact.push(type)
    else
      prefixes.push(type.slice(0, -1))
  }
  return { exact, prefixes }
}

function matchingEvents(db: DatabaseSync, pattern: EventPattern, after: number, through: number): StoredEvent[] {
  const { exact, prefixes } = exactAndPrefixes(pattern)
  const terms = [
    ...(exact.length === 0 ? [] : [`type IN (${exact.map(() => '?').join(', ')})`]),
    ...prefixes.map(() => 'substr(type, 1, ?) = ?'),
  ]
  const query = `SELECT ${STORED_COLUMNS} FROM events WHERE id > ? AND id <= ? AND (${terms.join(' OR ')}) ORDER BY id`
  return db.prepare(query).all(after, through, ...exact, ...prefixes.flatMap(prefix => [prefix.length, prefix])) as unknown as StoredEvent[]
}

export function equivalenceOf(node: readonly string[], derived: readonly string[]): Equivalence {
  const fromDerive = new Set(derived)
  const fromNode = new Set(node)
  return {
    same: [...fromNode].filter(key => fromDerive.has(key)).sort(),
    only_node: [...fromNode].filter(key => !fromDerive.has(key)).sort(),
    only_derive: [...fromDerive].filter(key => !fromNode.has(key)).sort(),
  }
}

function isDenied(step: NodeStep): step is DeniedStep {
  return step.kind === 'denied'
}

export abstract class Node<S extends NodeStep> {
  readonly actor: string
  readonly slots: number
  private subscription: Subscription | null = null
  private lastStep: S | IdleStep | null = null
  private startedAt: string | null = null

  constructor(readonly kind: NodeKind, protected readonly parts: NodeParts) {
    this.actor = `worker:${kind}:${parts.session}`
    this.slots = slotsOf(kind, parts.env)
  }

  protected get db(): DatabaseSync {
    return this.parts.db
  }

  protected ts(): string {
    return this.parts.clock().toISOString()
  }

  log(message: string, meta?: unknown): void {
    console.log(`${prefixOf(this.kind)}${message}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`)
  }

  getState(): NodeSnapshot {
    const leased = (this.db.prepare(LEASED_BY).all(this.actor) as { task_key: string }[]).map(row => row.task_key)
    return { kind: this.kind, actor: this.actor, mode: this.parts.mode, slots: this.slots, cursor: this.cursor(), leased, lastStep: this.lastStep, startedAt: this.startedAt }
  }

  subscribe(pattern: EventPattern, handler: (event: StoredEvent) => void): Unsubscribe {
    if (this.subscription !== null)
      throw new SecondSubscription(`the ${this.kind} node already holds its one subscription`)
    exactAndPrefixes(pattern)
    const subscription = { pattern, handler }
    this.subscription = subscription
    return () => {
      if (this.subscription === subscription)
        this.subscription = null
    }
  }

  emit(event: BusEvent): void {
    appendEvent(this.db, { ...event, actor: event.actor ?? this.actor, ts: event.ts ?? this.ts() })
  }

  async run(ctx: NodeContext): Promise<void> {
    this.before()
    this.startedAt = this.ts()
    this.openCursor()
    this.log(`the ${this.kind} node ${this.actor} takes the ${this.kind} queue, detection ${this.parts.mode}, ${this.slots} slot(s)`)
    const inFlight = new Map<string, Promise<S>>()
    let lastTick: number | null = null
    let checkWake: Promise<null> | null = null
    const nextCheckWake = async (): Promise<null> => {
      await ctx.pause(CHECK_MS)
      checkWake = null
      return null
    }
    while (ctx.signal?.aborted !== true) {
      this.retryWhenLocked('deliver', () => this.deliver())
      const now = this.parts.clock().getTime()
      if ((lastTick === null || now - lastTick >= TICK_MS) && this.retryWhenLocked('tick', () => this.tick()))
        lastTick = now
      this.fill(inFlight)
      if (inFlight.size === 0) {
        this.lastStep = IDLE
        await ctx.pause(this.pauseAfter(IDLE))
        continue
      }
      const settledThisTurn = await Promise.race([...inFlight.values(), nextTurn(null)])
      const step = settledThisTurn ?? await Promise.race([...inFlight.values(), checkWake ??= nextCheckWake()])
      if (step !== null)
        await Promise.race([ctx.pause(this.pauseAfter(step)), ...inFlight.values(), checkWake ??= nextCheckWake()])
    }
    await Promise.all(inFlight.values())
  }

  protected before(): void {}

  protected abstract candidates(scope?: Scope): QueuedTask[]

  protected abstract handle(lease: Lease): S | Promise<S>

  protected derivedCandidates(_ts: string): QueuedTask[] | null {
    return null
  }

  protected leaseOrder(): LeaseOrder | undefined {
    return undefined
  }

  protected pauseAfter(step: S | IdleStep): number {
    return step.kind === 'idle' ? CHECK_MS : TICK_MS
  }

  protected stepLine(step: S): string | null {
    if (step.kind === 'fenced')
      return `${step.taskKey}: the lease moved on; nothing written`
    if (!isDenied(step))
      return null
    const reason = step.denial.kind === 'technical' ? step.denial.reason : step.denial.rule
    return `${step.taskKey}: denied (${step.denial.kind}, ${reason}): ${step.denial.detail}; the task is ${step.next}`
  }

  protected detectOn(event: StoredEvent, scope?: Scope): void {
    for (const task of this.candidates(scope))
      this.record(task, 'event', event.id)
  }

  private record(task: QueuedTask, via: Via, eventId: number): void {
    const ts = this.ts()
    const key = keyOf(task)
    const live = this.parts.mode === 'live'
    const outcome = live ? { outcome: queueTaskWithin(this.db, ts, task) ? 'queued' : 'already' } : {}
    appendEvent(this.db, { ts, type: NODE_DETECTED, actor: this.actor, cardId: task.cardId, pr: task.pr ?? null, head: task.head ?? null, dedupeKey: `${NODE_DETECTED}:${this.kind}:${key}${live ? '' : `:${via}`}`, payload: { key, via, event_id: eventId, ...outcome }, legacy: false })
  }

  private cursor(): number | null {
    const row = this.db.prepare(`SELECT event_id FROM ${NODE_CURSORS} WHERE kind = ?`).get(this.kind) as { event_id: number } | undefined
    return row === undefined ? null : Number(row.event_id)
  }

  private openCursor(): void {
    this.db.prepare(`INSERT INTO ${NODE_CURSORS} (kind, event_id) VALUES (?, ?) ON CONFLICT (kind) DO NOTHING`).run(this.kind, lastEventId(this.db))
  }

  private deliver(): void {
    const subscription = this.subscription
    if (subscription === null)
      return
    inTransaction(this.db, () => {
      const after = this.cursor() ?? 0
      const through = lastEventId(this.db)
      if (through <= after)
        return
      for (const event of matchingEvents(this.db, subscription.pattern, after, through))
        subscription.handler(event)
      this.db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = ? WHERE kind = ?`).run(through, this.kind)
    })
  }

  private tick(): void {
    inTransaction(this.db, () => {
      const through = lastEventId(this.db)
      const found = this.candidates()
      const derived = this.derivedCandidates(this.ts())
      const equivalence = derived === null ? null : equivalenceOf(found.map(keyOf), derived.map(keyOf))
      for (const task of found)
        this.record(task, 'tick', through)
      if (equivalence !== null) {
        const ts = this.ts()
        appendEvent(this.db, { ts, type: NODE_EQUIVALENCE, actor: this.actor, cardId: null, pr: null, head: null, dedupeKey: `${NODE_EQUIVALENCE}:${this.kind}:${this.actor}:${through}:${ts}`, payload: { ...equivalence, event_id: through }, legacy: false })
      }
    })
  }

  protected executes(): boolean {
    return true
  }

  private take(): Lease | null {
    if (!this.executes())
      return null
    const ts = this.ts()
    expireLeases(this.db, ts)
    if (drainOpen(this.db, ts))
      return null
    return leaseNext(this.db, ts, this.kind, this.actor, this.leaseOrder())
  }

  private retryWhenLocked(step: string, work: () => void): boolean {
    try {
      work()
      return true
    }
    catch (error) {
      if (!isDatabaseLocked(error))
        throw error
      this.log(`the ${step} hit ${DATABASE_LOCKED}; it is retried on the next turn, and the leases in flight keep running`)
      return false
    }
  }

  private fill(inFlight: Map<string, Promise<S>>): void {
    const taken: Lease[] = []
    this.retryWhenLocked('take', () => {
      while (inFlight.size + taken.length < this.slots) {
        const lease = this.take()
        if (lease === null)
          break
        taken.push(lease)
      }
    })
    for (const lease of taken) {
      inFlight.set(lease.taskKey, (async () => {
        try {
          const step = await this.settle(lease)
          this.lastStep = step
          return step
        }
        finally {
          inFlight.delete(lease.taskKey)
        }
      })())
    }
  }

  private async settle(lease: Lease): Promise<S> {
    const heartbeat = setInterval(() => this.renew(lease, heartbeat), RENEW_MS)
    try {
      const step = await this.handle(lease)
      const line = this.stepLine(step)
      if (line !== null)
        this.log(line)
      return step
    }
    finally {
      clearInterval(heartbeat)
    }
  }

  private renew(lease: Lease, heartbeat: NodeJS.Timeout): void {
    try {
      renewLease(this.db, this.ts(), lease)
    }
    catch (error) {
      if (error instanceof StaleLease)
        clearInterval(heartbeat)
      else
        this.log(`${lease.taskKey}: the lease was not renewed this beat, the heartbeat keeps running: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export async function runNode(argv: readonly string[], kind: NodeKind, busPath: string, build: (db: DatabaseSync, mode: DetectionMode) => Node<NodeStep>, ctx: NodeContext): Promise<number> {
  const prefix = prefixOf(kind)
  if (!argv.includes(SWITCH_FLAG)) {
    console.log(`${prefix}switched off; start it with ${SWITCH_FLAG}`)
    return 0
  }
  const db = openBus(busPath)
  try {
    await build(db, detectionMode(argv)).run(ctx)
    return 0
  }
  catch (error) {
    if (!(error instanceof NodeRefused))
      throw error
    console.error(`${prefix}refused to switch on: ${error.message}`)
    return 1
  }
  finally {
    db.close()
  }
}

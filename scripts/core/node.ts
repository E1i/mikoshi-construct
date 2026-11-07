import type { DatabaseSync } from 'node:sqlite'
import type { SlotKind } from '../supervisor/scheduler.js'
import type { Understood } from './bus-version.js'
import type { BusEvent } from './db.js'
import type { Queue } from './identifiers.js'
import type { HolderStart, Lease, LeaseOrder } from './lease.js'
import type { QueuedTask } from './queue.js'
import type { StoredEvent } from './stored.js'
import { execFileSync } from 'node:child_process'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { RateLimited } from '../ports/meter.js'
import { CHECK_MS, TICK_MS } from '../ports/netwatch.js'
import { ownStart, recordProcessHeartbeat } from '../supervisor/heartbeat.js'
import { slotsOf } from '../supervisor/scheduler.js'
import { lastEventId } from '../window/operator-work.js'
import { BUS_VERSION, busVersionOf, CARD_VERSION, cardVersionOf, UNRECORDED_VERSION } from './bus-version.js'
import { cardBodyText } from './card-bodies.js'
import { appendEvent, inTransaction, openBus } from './db.js'
import { NODE_DETECTED, NODE_EQUIVALENCE, TASK_LEASED } from './events.js'
import { drainOpen, expireLeases, leasedByRetiring, leaseNext, recordWorkerStarted, RENEW_MS, renewLease, StaleLease, waitTask, workerRetiring } from './lease.js'
import { keyOf, LEASED, queueTaskWithin } from './queue.js'
import { STORED_COLUMNS } from './stored.js'

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

export interface WaitStep {
  kind: 'waiting'
  taskKey: string
  reason: string
  until: string
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
  self?: HolderStart
  codeSha?: () => string | null
}

export function loadedCodeSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  }
  catch {
    return null
  }
}

export interface Equivalence {
  same: string[]
  only_node: string[]
  only_derive: string[]
}

export type ScopeOf = (event: StoredEvent) => Scope | undefined

interface Subscription {
  pattern: EventPattern
  scopeOf: ScopeOf
}

interface ScopedEvent {
  id: number
  scope: Scope | undefined
}

interface Detection {
  task: QueuedTask
  eventId: number
}

export class SecondSubscription extends Error {}

export class NodeRefused extends Error {}

export class ForeignVersion extends NodeRefused {}

export interface NodeDeclaration {
  kind: NodeKind
  on: EventPattern
  understands: Understood
}

export type VersionedRecord = keyof Understood

export const UNDERSTOOD_NOW: Understood = { bus: [UNRECORDED_VERSION, BUS_VERSION], card: [CARD_VERSION] }

export function foreignVersion(understands: Understood, record: VersionedRecord, version: number, whose: string): string | null {
  if (understands[record].includes(version))
    return null
  return `${whose} carries ${record} version ${version}, and this node understands ${record} versions ${understands[record].join(', ')}; it takes no work from it`
}

const IDLE: IdleStep = { kind: 'idle' }

const WHOLE_QUEUE: ScopeOf = () => undefined

const LEASED_BY = `
  SELECT tasks.task_key FROM tasks JOIN events ON events.dedupe_key = '${TASK_LEASED}:' || tasks.task_key || ':' || tasks.lease_gen
  WHERE tasks.state = '${LEASED}' AND events.actor = ? ORDER BY tasks.id
`

const TAKEN_SINCE = `SELECT 1 FROM tasks WHERE task_key = ? AND event_id > ?`

const CHANGED_SINCE = `
  SELECT 1 FROM events WHERE id > ? AND actor IS NOT ? AND (card_id = ? OR pr = ?) LIMIT 1
`

export const DERIVE_EVERY_TICKS = 5

export const DATABASE_LOCKED = 'database is locked'

export function isDatabaseLocked(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DATABASE_LOCKED)
}

export function nodeProcess(kind: NodeKind): string {
  return `bus:${kind}`
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

function inScope(task: QueuedTask, scope: Scope | undefined): boolean {
  return scope === undefined || ((scope.pr === undefined || task.pr === scope.pr) && (scope.cardId === undefined || task.cardId === scope.cardId))
}

function firstDetections(found: readonly QueuedTask[], events: readonly ScopedEvent[]): Detection[] {
  const first = new Map<string, Detection>()
  for (const event of events) {
    for (const task of found) {
      const key = keyOf(task)
      if (!first.has(key) && inScope(task, event.scope))
        first.set(key, { task, eventId: event.id })
    }
  }
  return [...first.values()]
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

export function isWait(step: NodeStep): step is WaitStep {
  return step.kind === 'waiting'
}

export function waitLine(step: WaitStep): string {
  return `${step.taskKey}: waits until ${step.until} (${step.reason}); no failure counted`
}

function isDenied(step: NodeStep): step is DeniedStep {
  return step.kind === 'denied'
}

export abstract class Node<S extends NodeStep> {
  readonly actor: string
  readonly slots: number
  private subscription: Subscription | null = null
  private declaration: NodeDeclaration | null = null
  private lastStep: S | WaitStep | IdleStep | null = null
  private startedAt: string | null = null
  private startRecorded = false
  private ticksUntilDerive = 0
  private codeSha: string | null = null

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

  subscribe(pattern: EventPattern, scopeOf: ScopeOf = WHOLE_QUEUE): Unsubscribe {
    if (this.subscription !== null)
      throw new SecondSubscription(`the ${this.kind} node already holds its one subscription`)
    exactAndPrefixes(pattern)
    const subscription = { pattern, scopeOf }
    this.subscription = subscription
    return () => {
      if (this.subscription === subscription)
        this.subscription = null
    }
  }

  protected declare(declaration: NodeDeclaration, scopeOf: ScopeOf = WHOLE_QUEUE): Unsubscribe {
    if (declaration.kind !== this.kind)
      throw new Error(`the ${this.kind} node was handed the declaration of the ${declaration.kind} node`)
    const unsubscribe = this.subscribe(declaration.on, scopeOf)
    this.declaration = declaration
    return unsubscribe
  }

  declared(): NodeDeclaration | null {
    return this.declaration
  }

  private refuseForeign(record: VersionedRecord, version: number, whose: string): void {
    const refusal = this.declaration === null ? null : foreignVersion(this.declaration.understands, record, version, whose)
    if (refusal !== null)
      throw new ForeignVersion(refusal)
  }

  private refuseForeignCard(lease: Lease): void {
    const text = cardBodyText(this.db, lease.cardId)
    if (text !== null)
      this.refuseForeign('card', cardVersionOf(text), `card #${lease.cardId} (${lease.taskKey})`)
  }

  emit(event: BusEvent): void {
    appendEvent(this.db, { ...event, actor: event.actor ?? this.actor, ts: event.ts ?? this.ts() })
  }

  async run(ctx: NodeContext): Promise<void> {
    this.refuseForeign('bus', busVersionOf(this.db), 'the bus')
    this.before()
    this.codeSha = (this.parts.codeSha ?? loadedCodeSha)()
    this.startedAt = this.ts()
    this.recordStart()
    this.openCursor()
    this.log(`the ${this.kind} node ${this.actor} takes the ${this.kind} queue, detection ${this.parts.mode}, ${this.slots} slot(s)`)
    const inFlight = new Map<string, Promise<S | WaitStep>>()
    let lastTick: number | null = null
    let checkWake: Promise<null> | null = null
    const nextCheckWake = async (): Promise<null> => {
      await ctx.pause(CHECK_MS)
      checkWake = null
      return null
    }
    while (ctx.signal?.aborted !== true && !this.retiring()) {
      this.recordStart()
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

  private retiring(): boolean {
    let retiring = false
    this.retryWhenLocked('retirement read', () => {
      retiring = workerRetiring(this.db, this.actor)
    })
    if (retiring)
      this.log(`${this.actor} is retiring: it takes no new lease, finishes the rounds it holds on the code it started with, and exits`)
    return retiring
  }

  private recordStart(): void {
    if (!this.startRecorded)
      this.startRecorded = this.retryWhenLocked('start record', () => recordWorkerStarted(this.db, this.ts(), this.actor, this.parts.self ?? ownStart()))
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

  protected pauseAfter(step: S | WaitStep | IdleStep): number {
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
    const cursor = this.cursor()
    const after = cursor ?? 0
    const through = lastEventId(this.db)
    if (through <= after)
      return
    const events = matchingEvents(this.db, subscription.pattern, after, through).map(event => ({ id: event.id, scope: subscription.scopeOf(event) }))
    const detections = events.length === 0 ? [] : firstDetections(this.candidates(), events)
    inTransaction(this.db, () => {
      if (this.cursor() !== cursor)
        return
      for (const { task, eventId } of detections) {
        if (this.stillStands(task, through))
          this.record(task, 'event', eventId)
      }
      this.db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = ? WHERE kind = ?`).run(through, this.kind)
    })
  }

  private stillStands(task: QueuedTask, through: number): boolean {
    const taken = this.db.prepare(TAKEN_SINCE).get(keyOf(task), through) !== undefined
    return !taken && this.db.prepare(CHANGED_SINCE).get(through, this.actor, task.cardId, task.pr ?? null) === undefined
  }

  private tick(): void {
    const through = lastEventId(this.db)
    const cursor = this.cursor()
    const found = this.candidates()
    const derives = this.ticksUntilDerive === 0
    const derived = derives ? this.derivedCandidates(this.ts()) : null
    const equivalence = derived === null ? null : equivalenceOf(found.map(keyOf), derived.map(keyOf))
    inTransaction(this.db, () => {
      const standing = this.cursor() === cursor ? found.filter(task => this.stillStands(task, through)) : []
      recordProcessHeartbeat(this.db, this.ts(), nodeProcess(this.kind), { queue: this.kind, slots: this.slots })
      for (const task of standing)
        this.record(task, 'tick', through)
      if (equivalence !== null) {
        const ts = this.ts()
        appendEvent(this.db, { ts, type: NODE_EQUIVALENCE, actor: this.actor, cardId: null, pr: null, head: null, dedupeKey: `${NODE_EQUIVALENCE}:${this.kind}:${this.actor}:${through}:${ts}`, payload: { ...equivalence, event_id: through }, legacy: false })
      }
    })
    this.ticksUntilDerive = derives ? DERIVE_EVERY_TICKS - 1 : this.ticksUntilDerive - 1
  }

  protected executes(): boolean {
    return true
  }

  private take(): Lease | null {
    if (!this.executes() || !this.startRecorded)
      return null
    const ts = this.ts()
    expireLeases(this.db, ts)
    if (drainOpen(this.db, ts, this.kind, this.codeSha))
      return null
    const lease = leaseNext(this.db, ts, this.kind, this.actor, this.leaseOrder())
    if (lease !== null)
      this.refuseForeignCard(lease)
    return lease
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

  private fill(inFlight: Map<string, Promise<S | WaitStep>>): void {
    const taken: Lease[] = []
    this.retryWhenLocked('take', () => {
      const elsewhere = leasedByRetiring(this.db, this.kind)
      while (elsewhere + inFlight.size + taken.length < this.slots) {
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

  protected renewsByTimer(): boolean {
    return true
  }

  protected waitOn(lease: Lease, reason: string, until: string): WaitStep {
    waitTask(this.db, this.ts(), lease, { reason, until })
    return { kind: 'waiting', taskKey: lease.taskKey, reason, until }
  }

  private async handleOrWait(lease: Lease): Promise<S | WaitStep> {
    try {
      return await this.handle(lease)
    }
    catch (error) {
      if (!(error instanceof RateLimited))
        throw error
      const until = new Date(this.parts.clock().getTime() + error.retryAfterSeconds * 1000).toISOString()
      return this.waitOn(lease, error.message, until)
    }
  }

  private async settle(lease: Lease): Promise<S | WaitStep> {
    const heartbeat = this.renewsByTimer() ? setInterval(() => this.renew(lease, heartbeat), RENEW_MS) : undefined
    try {
      const step = await this.handleOrWait(lease)
      const line = isWait(step) ? waitLine(step) : this.stepLine(step)
      if (line !== null)
        this.log(line)
      return step
    }
    finally {
      clearInterval(heartbeat)
    }
  }

  private renew(lease: Lease, heartbeat: NodeJS.Timeout | undefined): void {
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
    console.error(`${prefix}${error instanceof ForeignVersion ? 'stopped on a foreign version' : 'refused to switch on'}: ${error.message}`)
    return 1
  }
  finally {
    db.close()
  }
}

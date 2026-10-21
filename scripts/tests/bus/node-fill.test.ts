import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../bus/lease.js'
import type { NodeStep, Scope } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openBus } from '../../bus/db.js'
import { openDrain, releaseTask } from '../../bus/lease.js'
import { CHECK_MS, TICK_MS } from '../../bus/netwatch.js'
import { Node } from '../../bus/node.js'
import { keyOf, queueTaskWithin } from '../../bus/queue.js'
import { slotsVariable } from '../../bus/scheduler.js'
import { DRAIN_LIMIT_MS, recordRestarted } from '../../bus/supervisor.js'
import { TASK_LEASED } from '../../core/events.js'
import { Clock } from './github-fake.js'

const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-node-fill-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function task(pr: number): QueuedTask {
  return { queue: 'review', cardId: pr + 100 }
}

class ReleasingNode extends Node<NodeStep> {
  constructor(db: DatabaseSync, readonly clock: Clock, slots: number) {
    super('review', { db, clock: clock.now, session: 'fill', mode: 'live', env: { [slotsVariable('review')]: String(slots) } })
  }

  protected candidates(_scope?: Scope): QueuedTask[] {
    return []
  }

  private readonly handled = new Set<string>()

  protected handle(lease: Lease): NodeStep {
    if (this.handled.has(lease.taskKey))
      return { kind: 'retaken', taskKey: lease.taskKey }
    this.handled.add(lease.taskKey)
    releaseTask(this.db, this.clock.now().toISOString(), lease, 'released inside handle')
    return { kind: 'released', taskKey: lease.taskKey }
  }
}

class BlockingNode extends Node<NodeStep> {
  readonly handledWhileFirstRuns: string[] = []
  private firstRunning = false
  private releaseFirst: () => void = () => {}

  constructor(db: DatabaseSync, clock: Clock, slots: number, private readonly blocked: string) {
    super('review', { db, clock: clock.now, session: 'fill', mode: 'live', env: { [slotsVariable('review')]: String(slots) } })
  }

  protected candidates(_scope?: Scope): QueuedTask[] {
    return []
  }

  protected async handle(lease: Lease): Promise<NodeStep> {
    if (lease.taskKey !== this.blocked) {
      if (this.firstRunning)
        this.handledWhileFirstRuns.push(lease.taskKey)
      return { kind: 'fenced', taskKey: lease.taskKey }
    }
    this.firstRunning = true
    await new Promise<void>((resolve) => {
      this.releaseFirst = resolve
    })
    this.firstRunning = false
    return { kind: 'fenced', taskKey: lease.taskKey }
  }

  finishFirst(): void {
    this.releaseFirst()
  }
}

class HookedNode extends BlockingNode {
  constructor(db: DatabaseSync, clock: Clock, slots: number, blocked: string, private readonly onQuick: (key: string) => void) {
    super(db, clock, slots, blocked)
  }

  protected override async handle(lease: Lease): Promise<NodeStep> {
    this.onQuick(lease.taskKey)
    return super.handle(lease)
  }
}

function realPause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

async function onePass(node: Node<NodeStep>): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function leasedEvents(db: DatabaseSync, key: string): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ? AND dedupe_key LIKE ?').get(TASK_LEASED, `${TASK_LEASED}:${key}:%`) as { n: number }).n)
}

function leaseGen(db: DatabaseSync, key: string): number {
  return Number((db.prepare('SELECT lease_gen FROM tasks WHERE task_key = ?').get(key) as { lease_gen: number }).lease_gen)
}

describe('a drain before a restart', () => {
  it('while leases.draining is open a fill pass takes no task, and after supervisor.restarted it takes it', async () => {
    const db = newBus()
    const clock = new Clock()
    const node = new ReleasingNode(db, clock, 3)
    const ts = clock.now().toISOString()
    queueTaskWithin(db, ts, task(970))
    const key = keyOf(task(970))
    openDrain(db, ts, 'b'.repeat(40), new Date(clock.now().getTime() + DRAIN_LIMIT_MS).toISOString())
    await onePass(node)

    expect(leasedEvents(db, key)).toBe(0)

    recordRestarted(db, ts, 'b'.repeat(40))
    await onePass(node)

    expect(leasedEvents(db, key)).toBe(1)
  })
})

describe('a fill pass', () => {
  it('a node whose handle releases its task synchronously takes each key once in one fill pass, lease_gen grows by exactly 1 and the lease is not fenced before its settle', async () => {
    const db = newBus()
    const clock = new Clock()
    const node = new ReleasingNode(db, clock, 3)
    queueTaskWithin(db, clock.now().toISOString(), task(970))
    const key = keyOf(task(970))
    await onePass(node)

    expect(leasedEvents(db, key)).toBe(1)
    expect(leaseGen(db, key)).toBe(1)
    expect(node.getState().lastStep).toEqual({ kind: 'released', taskKey: key })
  })

  it('with two tasks and two slots a node whose handle releases synchronously takes both keys once in one pass', async () => {
    const db = newBus()
    const clock = new Clock()
    const node = new ReleasingNode(db, clock, 2)
    queueTaskWithin(db, clock.now().toISOString(), task(970))
    queueTaskWithin(db, clock.now().toISOString(), task(971))
    await onePass(node)

    for (const each of [task(970), task(971)]) {
      expect(leasedEvents(db, keyOf(each))).toBe(1)
      expect(leaseGen(db, keyOf(each))).toBe(1)
    }
  })

  it('with three slots a second task is leased while the first still runs', async () => {
    const db = newBus()
    const clock = new Clock()
    const first = keyOf(task(970))
    const node = new BlockingNode(db, clock, 3, first)
    queueTaskWithin(db, clock.now().toISOString(), task(970))
    const controller = new AbortController()
    let pauses = 0
    await node.run({
      pause: async () => {
        pauses += 1
        if (pauses === 1) {
          queueTaskWithin(db, clock.now().toISOString(), task(971))
          return
        }
        controller.abort()
        node.finishFirst()
      },
      signal: controller.signal,
    })

    expect(node.handledWhileFirstRuns).toEqual([keyOf(task(971))])
    expect(leasedEvents(db, first)).toBe(1)
  })

  it('on real timers with three slots, a task queued as another settles is leased before TICK_MS while the first still runs', async () => {
    const db = newBus()
    const clock = new Clock()
    const first = keyOf(task(970))
    const quick = keyOf(task(971))
    const late = keyOf(task(972))
    const node = new HookedNode(db, clock, 3, first, (key) => {
      if (key === quick)
        queueTaskWithin(db, clock.now().toISOString(), task(972))
    })
    queueTaskWithin(db, clock.now().toISOString(), task(970))
    queueTaskWithin(db, clock.now().toISOString(), task(971))
    const controller = new AbortController()
    const running = node.run({ pause: realPause, signal: controller.signal })
    const started = Date.now()

    try {
      await vi.waitFor(() => expect(leasedEvents(db, late)).toBe(1), { timeout: 3 * CHECK_MS, interval: 50 })
      expect(Date.now() - started).toBeLessThan(TICK_MS)
      expect(node.handledWhileFirstRuns).toEqual([quick, late])
    }
    finally {
      controller.abort()
      node.finishFirst()
      await running
    }
  }, 6 * CHECK_MS)

  it('with every slot busy, an event appended meanwhile is delivered and its cursor recorded', async () => {
    const db = newBus()
    const clock = new Clock()
    const first = keyOf(task(970))
    const node = new BlockingNode(db, clock, 1, first)
    const delivered: number[] = []
    node.subscribe(['test.delivered'], event => delivered.push(Number(event.id)))
    queueTaskWithin(db, clock.now().toISOString(), task(970))
    const controller = new AbortController()
    let appended = 0
    let pauses = 0
    await node.run({
      pause: async () => {
        pauses += 1
        if (pauses === 1) {
          node.emit({ ts: clock.now().toISOString(), type: 'test.delivered', actor: node.actor, cardId: null, pr: null, head: null, dedupeKey: 'test.delivered:1', payload: {}, legacy: false })
          appended = Number((db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
          return
        }
        controller.abort()
        node.finishFirst()
      },
      signal: controller.signal,
    })

    expect(delivered).toEqual([appended])
    expect(node.getState().cursor).toBeGreaterThanOrEqual(appended)
    expect(leasedEvents(db, first)).toBe(1)
  })
})

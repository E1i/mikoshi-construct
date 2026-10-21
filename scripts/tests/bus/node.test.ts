import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../bus/lease.js'
import type { DetectionMode, NodeStep, Scope } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { completeTask } from '../../bus/lease.js'
import { RateLimited } from '../../bus/meter.js'
import { TICK_MS } from '../../bus/netwatch.js'
import { Node, NODE_CURSORS, nodeProcess, SecondSubscription } from '../../bus/node.js'
import { keyOf } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { slotsVariable } from '../../bus/scheduler.js'
import { NODE_DETECTED, NODE_EQUIVALENCE, PROCESS_HEARTBEAT, TASK_ENQUEUED, TASK_FAILED, TASK_LEASED, TASK_RELEASED } from '../../core/events.js'
import { Clock, sha } from './github-fake.js'

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
  const root = mkdtempSync(path.join(tmpdir(), 'bus-node-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

const PROBE_SEEN = 'probe.seen'

function task(pr: number): QueuedTask {
  return { queue: 'merge', cardId: pr + 100, pr, head: sha('a') }
}

class FakeNode extends Node<NodeStep> {
  found: QueuedTask[] = []
  derived: QueuedTask[] | null = null
  failAfterRecord = false

  constructor(db: DatabaseSync, readonly clock: Clock, mode: DetectionMode, pattern: readonly string[] = [PROBE_SEEN, 'ci.*'], env: NodeJS.ProcessEnv = {}) {
    super('merge', { db, clock: clock.now, session: 'fake', mode, env })
    this.subscribe(pattern, (event) => {
      this.detectOn(event, { pr: event.pr ?? undefined })
      if (this.failAfterRecord)
        throw new Error('injected after the record and before the cursor')
    })
  }

  protected candidates(scope?: Scope): QueuedTask[] {
    return this.found.filter(each => scope?.pr === undefined || each.pr === scope.pr)
  }

  protected override derivedCandidates(): QueuedTask[] | null {
    return this.derived
  }

  protected handle(lease: Lease): NodeStep | Promise<NodeStep> {
    completeTask(this.db, this.clock.now().toISOString(), lease, [])
    return { kind: 'done', taskKey: lease.taskKey }
  }
}

async function once(node: Node<NodeStep>): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function seen(db: DatabaseSync, clock: Clock, pr: number, type = PROBE_SEEN): number {
  appendEvent(db, { ts: clock.now().toISOString(), type, actor: 'netwatch', cardId: null, pr, head: null, dedupeKey: `${type}:${pr}:${clock.now().getTime()}`, payload: {}, legacy: false })
  clock.advance(1_000)
  return Number((db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
}

function detections(db: DatabaseSync, via?: string): { key: string, via: string, event_id: number, outcome?: string }[] {
  return (db.prepare(`SELECT payload FROM events WHERE type = ? ORDER BY id`).all(NODE_DETECTED) as { payload: string }[])
    .map(row => JSON.parse(row.payload) as { key: string, via: string, event_id: number, outcome?: string })
    .filter(each => via === undefined || each.via === via)
}

function count(db: DatabaseSync, query: string, ...args: (string | number)[]): number {
  return Number((db.prepare(query).get(...args) as { n: number }).n)
}

function enqueued(db: DatabaseSync): number {
  return count(db, 'SELECT count(*) AS n FROM events WHERE type = ?', TASK_ENQUEUED)
}

function cursorOf(db: DatabaseSync): number | null {
  const row = db.prepare(`SELECT event_id FROM ${NODE_CURSORS} WHERE kind = 'merge'`).get() as { event_id: number } | undefined
  return row === undefined ? null : Number(row.event_id)
}

describe('a node', () => {
  it('a running bus node writes process.heartbeat every tick', async () => {
    const db = newBus()
    const clock = new Clock()
    const node = new FakeNode(db, clock, 'shadow')
    const ticks: string[] = []
    const controller = new AbortController()
    await node.run({
      pause: async () => {
        ticks.push(clock.now().toISOString())
        clock.advance(TICK_MS)
        if (ticks.length === 3)
          controller.abort()
      },
      signal: controller.signal,
    })

    const beats = db.prepare('SELECT ts, payload FROM events WHERE type = ? ORDER BY id').all(PROCESS_HEARTBEAT) as { ts: string, payload: string }[]
    expect(nodeProcess('merge')).toBe('bus:merge')
    expect(beats.map(beat => ({ ts: beat.ts, process: (JSON.parse(beat.payload) as { process: string }).process }))).toEqual(ticks.map(ts => ({ ts, process: 'bus:merge' })))
  })

  it('holds one subscription: a second subscribe throws, and a pattern is event types with at most a trailing *', () => {
    const node = new FakeNode(newBus(), new Clock(), 'shadow')
    expect(() => node.subscribe(['other'], () => {})).toThrow(SecondSubscription)
    for (const pattern of [['*'], ['ci.*.x'], ['']])
      expect(() => new FakeNode(newBus(), new Clock(), 'shadow', pattern)).toThrow(/trailing \*/)
  })

  it('starts its cursor at the last event on its first run, and an earlier event is not delivered', async () => {
    const db = newBus()
    const clock = new Clock()
    const node = new FakeNode(db, clock, 'shadow')
    const before = seen(db, clock, 970)
    node.found = [task(970)]
    await once(node)

    expect(cursorOf(db)).toBe(before)
    expect(detections(db, 'event')).toEqual([])
    expect(detections(db, 'tick')).toEqual([{ key: keyOf(task(970)), via: 'tick', event_id: before }])
  })

  it('delivers an exact type and a trailing-* prefix, scoped by the event, and moves the cursor past the batch', async () => {
    const db = newBus()
    const clock = new Clock()
    const node = new FakeNode(db, clock, 'shadow')
    await once(node)
    node.found = [task(970), task(971)]
    const probe = seen(db, clock, 970)
    const ci = seen(db, clock, 971, 'ci.green')
    seen(db, clock, 970, 'other.type')
    await once(node)

    expect(detections(db, 'event')).toEqual([{ key: keyOf(task(970)), via: 'event', event_id: probe }, { key: keyOf(task(971)), via: 'event', event_id: ci }])
    expect(cursorOf(db)).toBe(Number((db.prepare(`SELECT max(id) AS id FROM events WHERE type NOT IN (?, ?)`).get(NODE_DETECTED, PROCESS_HEARTBEAT) as { id: number }).id))
  })

  for (const mode of ['shadow', 'live'] as const) {
    it(`in ${mode} mode a failure after the record and before the cursor rolls back both, and the replay writes one record`, async () => {
      const db = newBus()
      const clock = new Clock()
      const node = new FakeNode(db, clock, mode)
      await once(node)
      const cursor = cursorOf(db)
      node.found = [task(970)]
      seen(db, clock, 970)
      node.failAfterRecord = true
      await expect(once(node)).rejects.toThrow('injected')

      expect(cursorOf(db)).toBe(cursor)
      expect(detections(db)).toEqual([])
      expect(enqueued(db)).toBe(0)

      node.failAfterRecord = false
      await once(node)
      expect(detections(db, 'event').map(each => each.outcome)).toEqual([mode === 'live' ? 'queued' : undefined])
      expect(enqueued(db)).toBe(mode === 'live' ? 1 : 0)
      expect(count(db, 'SELECT count(*) AS n FROM tasks')).toBe(mode === 'live' ? 1 : 0)
    })
  }

  it('i2: an event written while the node is stopped is caught up by the cursor, and a candidate no event names is found by the tick', async () => {
    const db = newBus()
    const clock = new Clock()
    const node = new FakeNode(db, clock, 'shadow')
    await once(node)
    const missed = seen(db, clock, 970)
    node.found = [task(970), task(972)]
    const restarted = new FakeNode(db, clock, 'shadow')
    restarted.found = node.found
    await once(restarted)

    expect(detections(db, 'event')).toEqual([{ key: keyOf(task(970)), via: 'event', event_id: missed }])
    expect(detections(db, 'tick').map(each => each.key)).toEqual([keyOf(task(970)), keyOf(task(972))])
  })

  it('i3: a cursor reset to 0 replays every event and writes no second detection and no second task', async () => {
    for (const mode of ['shadow', 'live'] as const) {
      const db = newBus()
      const clock = new Clock()
      const node = new FakeNode(db, clock, mode)
      await once(node)
      node.found = [task(970)]
      seen(db, clock, 970)
      await once(node)
      await once(node)
      const before = { detected: detections(db).length, enqueued: enqueued(db) }

      db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = 0`).run()
      await once(node)
      await once(node)
      expect({ detected: detections(db).length, enqueued: enqueued(db) }, mode).toEqual(before)
    }
  })

  it('compares its candidates with the derived ones on one tick and records node.equivalence', async () => {
    const db = newBus()
    const clock = new Clock()
    const node = new FakeNode(db, clock, 'shadow')
    node.found = [task(970), task(971)]
    node.derived = [task(971), task(972)]
    await once(node)

    const payloads = (db.prepare('SELECT payload FROM events WHERE type = ?').all(NODE_EQUIVALENCE) as { payload: string }[]).map(row => JSON.parse(row.payload) as unknown)
    expect(payloads).toEqual([{ same: [keyOf(task(971))], only_node: [keyOf(task(970))], only_derive: [keyOf(task(972))], event_id: expect.any(Number) as unknown }])
  })

  it('node.detected and node.equivalence leave every projection as it was', async () => {
    const db = newBus()
    const clock = new Clock()
    appendEvent(db, { ts: clock.now().toISOString(), type: 'pr.observed', actor: 'netwatch', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: 'pr.observed:970', payload: { pr: 970, head: sha('a'), state: 'open', base: 'main', ci: 'green', mergeable: 'clean', draft: false }, legacy: false })
    reduce(db)
    const before = projectionDump(db)
    const node = new FakeNode(db, clock, 'shadow')
    node.found = [task(970)]
    node.derived = []
    await once(node)
    expect(detections(db)).toHaveLength(1)
    expect(count(db, 'SELECT count(*) AS n FROM events WHERE type = ?', NODE_EQUIVALENCE)).toBe(1)

    reduce(db)
    expect(projectionDump(db)).toBe(before)
  })

  it('a deliver that hits database is locked is logged and retried, and the in-flight lease completes', async () => {
    const db = newBus()
    const clock = new Clock()
    appendEvent(db, { ts: clock.now().toISOString(), type: 'pr.observed', actor: 'netwatch', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: 'pr.observed:970', payload: { pr: 970, head: sha('a'), state: 'open', base: 'main', ci: 'green', mergeable: 'clean', auto_merge: false, draft: false }, legacy: false })
    reduce(db)
    let release: () => void = () => {}
    const handled = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked = false
    let probe = 0
    const delivered: number[] = []
    class LockedNode extends FakeNode {
      constructor() {
        super(db, clock, 'live')
        this.subscribe([PROBE_SEEN], (event) => {
          if (locked)
            throw new Error('database is locked')
          delivered.push(event.id)
        })
      }

      override subscribe(pattern: readonly string[], handler: Parameters<FakeNode['subscribe']>[1]): () => void {
        if (pattern.includes('ci.*'))
          return () => {}
        return super.subscribe(pattern, handler)
      }

      protected override async handle(lease: Lease): Promise<NodeStep> {
        await handled
        return super.handle(lease)
      }
    }
    const node = new LockedNode()
    node.found = [task(970)]
    const lines = vi.mocked(console.log)
    const controller = new AbortController()
    let pauses = 0
    const run = node.run({
      signal: controller.signal,
      pause: async () => {
        pauses += 1
        await new Promise(resolve => setImmediate(resolve))
        if (pauses === 1) {
          probe = seen(db, clock, 970)
          locked = true
        }
        else if (pauses === 2) {
          locked = false
          release()
        }
        else {
          controller.abort()
        }
      },
    })

    await expect(run).resolves.toBeUndefined()
    expect(lines.mock.calls.map(call => String(call[0])).filter(line => line.includes('database is locked'))).toEqual([
      '[bus:merge] the deliver hit database is locked; it is retried on the next turn, and the leases in flight keep running',
    ])
    expect(db.prepare(`SELECT state FROM tasks WHERE task_key = ?`).get(keyOf(task(970)))).toEqual({ state: 'completed' })
    expect(delivered).toEqual([probe])
    expect(cursorOf(db)).toBeGreaterThanOrEqual(probe)
  })

  it('a tick that hits database is locked is logged and runs again on the next turn, before TICK_MS has passed', async () => {
    const db = newBus()
    const clock = new Clock()
    let calls = 0
    class LockedTick extends FakeNode {
      protected override candidates(scope?: Scope): QueuedTask[] {
        calls += 1
        if (calls === 1)
          throw new Error('database is locked')
        return super.candidates(scope)
      }
    }
    const node = new LockedTick(db, clock, 'shadow')
    node.found = [task(970)]
    const controller = new AbortController()
    let pauses = 0
    await node.run({
      signal: controller.signal,
      pause: async () => {
        pauses += 1
        if (pauses === 2)
          controller.abort()
      },
    })

    expect(vi.mocked(console.log).mock.calls.map(call => String(call[0])).filter(line => line.includes('database is locked'))).toEqual([
      '[bus:merge] the tick hit database is locked; it is retried on the next turn, and the leases in flight keep running',
    ])
    expect(detections(db, 'tick').map(each => each.key)).toEqual([keyOf(task(970))])
  })

  it('a take that hits database is locked is logged, and the leases taken before it still run to completion', async () => {
    const db = newBus()
    const clock = new Clock()
    let takes = 0
    class LockedTake extends FakeNode {
      protected override executes(): boolean {
        takes += 1
        if (takes === 2)
          throw new Error('database is locked')
        return true
      }
    }
    for (const pr of [970, 971])
      appendEvent(db, { ts: clock.now().toISOString(), type: 'pr.observed', actor: 'netwatch', cardId: pr + 100, pr, head: sha('a'), dedupeKey: `pr.observed:${pr}`, payload: { pr, head: sha('a'), state: 'open', base: 'main', ci: 'green', mergeable: 'clean', auto_merge: false, draft: false }, legacy: false })
    reduce(db)
    const node = new LockedTake(db, clock, 'live', [PROBE_SEEN], { [slotsVariable('merge')]: '2' })
    node.found = [task(970), task(971)]
    await once(node)

    expect(vi.mocked(console.log).mock.calls.map(call => String(call[0])).filter(line => line.includes('database is locked'))).toEqual([
      '[bus:merge] the take hit database is locked; it is retried on the next turn, and the leases in flight keep running',
    ])
    expect(count(db, `SELECT count(*) AS n FROM tasks WHERE state = 'completed'`)).toBe(1)
    expect(count(db, `SELECT count(*) AS n FROM tasks WHERE state = 'leased'`)).toBe(0)
  })

  it('an error other than database is locked escapes run', async () => {
    class Broken extends FakeNode {
      protected override candidates(): QueuedTask[] {
        throw new Error('disk I/O error')
      }
    }
    await expect(once(new Broken(newBus(), new Clock(), 'shadow'))).rejects.toThrow('disk I/O error')
    expect(vi.mocked(console.log).mock.calls.map(call => String(call[0])).filter(line => line.includes('database is locked'))).toEqual([])
  })

  it('a 403 with retry-after ends the task as wait and writes no task.failed', async () => {
    const db = newBus()
    const clock = new Clock()
    appendEvent(db, { ts: clock.now().toISOString(), type: 'pr.observed', actor: 'netwatch', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: 'pr.observed:970', payload: { pr: 970, head: sha('a'), state: 'open', base: 'main', ci: 'green', mergeable: 'clean', auto_merge: false, draft: false }, legacy: false })
    reduce(db)
    class LimitedNode extends FakeNode {
      protected override handle(): NodeStep {
        throw new RateLimited(403, 120)
      }
    }
    const node = new LimitedNode(db, clock, 'live')
    node.found = [task(970)]
    await once(node)

    const key = keyOf(task(970))
    const released = (db.prepare('SELECT ts, payload FROM events WHERE type = ?').all(TASK_RELEASED) as { ts: string, payload: string }[]).map(row => ({ ts: row.ts, ...JSON.parse(row.payload) as Record<string, unknown> }))
    expect(released).toMatchObject([{ task_key: key, reason: 'GitHub answered 403; retry after 120 s', until: new Date(Date.parse(released[0]!.ts) + 120_000).toISOString() }])
    expect(count(db, 'SELECT count(*) AS n FROM events WHERE type = ?', TASK_FAILED)).toBe(0)
    expect(db.prepare('SELECT state, failures FROM tasks WHERE task_key = ?').get(key)).toEqual({ state: 'queued', failures: 0 })

    clock.advance(60_000)
    await once(node)
    expect(count(db, 'SELECT count(*) AS n FROM events WHERE type = ?', TASK_LEASED)).toBe(1)
  })

  it('emit sets actor and ts only where the event leaves them out, and getState reads the cursor and the leases', async () => {
    const db = newBus()
    const clock = new Clock()
    const node = new FakeNode(db, clock, 'live')
    node.emit({ ts: null, type: 'probe.emitted', actor: null, cardId: null, pr: null, head: null, dedupeKey: 'probe.emitted:1', payload: {}, legacy: false })
    node.emit({ ts: '2026-01-01T00:00:00.000Z', type: 'probe.emitted', actor: 'policy', cardId: null, pr: null, head: null, dedupeKey: 'probe.emitted:2', payload: {}, legacy: false })
    expect(db.prepare(`SELECT actor, ts FROM events WHERE type = 'probe.emitted' ORDER BY id`).all()).toEqual([
      { actor: 'worker:merge:fake', ts: clock.now().toISOString() },
      { actor: 'policy', ts: '2026-01-01T00:00:00.000Z' },
    ])

    expect(node.getState()).toMatchObject({ kind: 'merge', actor: 'worker:merge:fake', mode: 'live', slots: 1, cursor: null, leased: [], lastStep: null, startedAt: null })
    await once(node)
    expect(node.getState()).toMatchObject({ cursor: cursorOf(db), lastStep: { kind: 'idle' }, startedAt: expect.any(String) as unknown })
  })
})

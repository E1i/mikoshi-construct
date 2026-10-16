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
import { Node, NODE_CURSORS, NODE_DETECTED, NODE_EQUIVALENCE, SecondSubscription } from '../../bus/node.js'
import { keyOf, TASK_ENQUEUED } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
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

  constructor(db: DatabaseSync, readonly clock: Clock, mode: DetectionMode, pattern: readonly string[] = [PROBE_SEEN, 'ci.*']) {
    super('merge', { db, clock: clock.now, session: 'fake', mode, env: {} })
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

  protected handle(lease: Lease): NodeStep {
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

function detections(db: DatabaseSync, via?: string): { key: string, via: string, event_id: number }[] {
  return (db.prepare(`SELECT payload FROM events WHERE type = ? ORDER BY id`).all(NODE_DETECTED) as { payload: string }[])
    .map(row => JSON.parse(row.payload) as { key: string, via: string, event_id: number })
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
    expect(cursorOf(db)).toBe(Number((db.prepare(`SELECT max(id) AS id FROM events WHERE type != ?`).get(NODE_DETECTED) as { id: number }).id))
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
      expect(detections(db, 'event')).toHaveLength(mode === 'shadow' ? 1 : 0)
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

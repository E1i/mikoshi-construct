import type { DatabaseSync } from 'node:sqlite'
import type { LockReading } from '../../core/db.js'
import type { Lease } from '../../core/lease.js'
import type { NodeStep } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openBus, watchLocks } from '../../core/db.js'
import { NODE_DETECTED, NODE_EQUIVALENCE, PROCESS_HEARTBEAT, TASK_ENQUEUED } from '../../core/events.js'
import { completeTask } from '../../core/lease.js'
import { DATABASE_LOCKED, DERIVE_EVERY_TICKS, Node, nodeProcess } from '../../core/node.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { TICK_MS } from '../../ports/netwatch.js'
import { Clock, sha } from './github-fake.js'

const BUSY_EVENTS = 150_000
const SHORT_BUSY_TIMEOUT_MS = 200
const FILLER_CARDS = 20

const OPEN_FILLER_CARDS = `
  SELECT cards.card_id FROM (SELECT DISTINCT card_id FROM events) AS cards
  WHERE NOT EXISTS (SELECT 1 FROM events AS later WHERE later.card_id = cards.card_id AND json_extract(later.payload, '$.index') = -1)
`
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-tick-lock-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

function fill(db: DatabaseSync, events: number): void {
  const insert = db.prepare(`INSERT INTO events (ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy) VALUES (?, 'probe.filler', 'netwatch', ?, ?, NULL, ?, ?, 0)`)
  db.exec('BEGIN IMMEDIATE')
  for (let index = 0; index < events; index++)
    insert.run('2026-10-23T00:00:00.000Z', 5_000 + (index % FILLER_CARDS), 4_000 + (index % FILLER_CARDS), `probe.filler:${index}`, JSON.stringify({ index, note: 'filler' }))
  db.exec('COMMIT')
}

function task(pr: number): QueuedTask {
  return { queue: 'merge', cardId: pr + 100, pr, head: sha('a') }
}

class ScanningNode extends Node<NodeStep> {
  found: QueuedTask[] = []
  derived: QueuedTask[] | null = null
  computed: () => void = () => {}

  constructor(db: DatabaseSync, readonly clock: Clock, session = 'scan') {
    super('merge', { db, clock: clock.now, session, mode: 'live', env: {} })
  }

  private scan(): number {
    return this.db.prepare(OPEN_FILLER_CARDS).all().length
  }

  protected candidates(): QueuedTask[] {
    this.scan()
    const found = this.found
    this.computed()
    return found
  }

  protected override derivedCandidates(): QueuedTask[] | null {
    if (this.derived === null)
      return null
    this.scan()
    return this.derived
  }

  protected handle(lease: Lease): NodeStep {
    completeTask(this.db, this.clock.now().toISOString(), lease, [])
    return { kind: 'done', taskKey: lease.taskKey }
  }
}

async function ticks(node: Node<NodeStep>, clock: Clock, count: number): Promise<void> {
  const controller = new AbortController()
  let done = 0
  await node.run({
    pause: async () => {
      clock.advance(TICK_MS)
      if (++done === count)
        controller.abort()
    },
    signal: controller.signal,
  })
}

function payloadsOf(db: DatabaseSync, type: string): Record<string, unknown>[] {
  return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>)
}

function lockedLines(): unknown[] {
  return vi.mocked(console.log).mock.calls.filter(call => String(call[0]).includes(DATABASE_LOCKED))
}

describe('a node tick and the write lock', () => {
  it('a node tick holds the write lock no longer than 1 s on a bus of 150k events', async () => {
    const file = busFile()
    const db = openBus(file)
    fill(db, BUSY_EVENTS)
    const clock = new Clock()
    const node = new ScanningNode(db, clock)
    node.found = [task(970)]
    node.derived = [task(970)]
    const holds: number[] = []
    watchLocks(db, { now: () => performance.now(), observe: (reading: LockReading) => holds.push(reading.holdMs ?? 0) })
    await ticks(node, clock, 1)

    expect(payloadsOf(db, NODE_DETECTED).map(each => each.key)).toEqual([keyOf(task(970))])
    expect(holds.length).toBeGreaterThan(0)
    expect(Math.max(...holds)).toBeLessThanOrEqual(1_000)
  }, 60_000)

  it('two nodes tick at the same time without database is locked', async () => {
    const file = busFile()
    const first = openBus(file)
    fill(first, BUSY_EVENTS)
    const second = openBus(file)
    for (const db of [first, second])
      db.exec(`PRAGMA busy_timeout = ${SHORT_BUSY_TIMEOUT_MS}`)
    const clock = new Clock()
    const otherClock = new Clock()
    otherClock.advance(1_000)
    const one = new ScanningNode(first, clock, 'one')
    const other = new ScanningNode(second, otherClock, 'other')
    one.found = [task(970)]
    other.found = [task(971)]
    let concurrent: Promise<void> = Promise.resolve()
    one.computed = () => {
      one.computed = () => {}
      concurrent = ticks(other, otherClock, 1)
    }
    await ticks(one, clock, 1)
    await concurrent

    expect(lockedLines()).toEqual([])
    expect(payloadsOf(first, PROCESS_HEARTBEAT).map(each => each.process)).toEqual([nodeProcess('merge'), nodeProcess('merge')])
    expect(payloadsOf(first, NODE_DETECTED).map(each => each.key).sort()).toEqual([keyOf(task(970)), keyOf(task(971))].sort())
  }, 60_000)

  it('a candidate another node took between computing and writing is not written', async () => {
    const file = busFile()
    const db = openBus(file)
    const other = openBus(file)
    for (const each of [db, other])
      each.exec(`PRAGMA busy_timeout = ${SHORT_BUSY_TIMEOUT_MS}`)
    const clock = new Clock()
    const node = new ScanningNode(db, clock)
    node.found = [task(970), task(972)]
    node.computed = () => {
      queueTask(other, clock.now().toISOString(), task(970))
    }
    await ticks(node, clock, 1)

    expect(payloadsOf(db, NODE_DETECTED).map(each => each.key)).toEqual([keyOf(task(972))])
    expect(payloadsOf(db, TASK_ENQUEUED).map(each => each.task_key)).toEqual([keyOf(task(970)), keyOf(task(972))])
    expect(payloadsOf(db, PROCESS_HEARTBEAT)).toHaveLength(1)
  })

  it('equivalence events are still written', async () => {
    const db = openBus(busFile())
    const clock = new Clock()
    const node = new ScanningNode(db, clock)
    node.found = [task(970), task(971)]
    node.derived = [task(971), task(972)]
    const tickCount = DERIVE_EVERY_TICKS + 1
    await ticks(node, clock, tickCount)

    expect(payloadsOf(db, PROCESS_HEARTBEAT)).toHaveLength(tickCount)
    expect(payloadsOf(db, NODE_EQUIVALENCE).map(({ event_id: _id, ...rest }) => rest)).toEqual([
      { same: [keyOf(task(971))], only_node: [keyOf(task(970))], only_derive: [keyOf(task(972))] },
      { same: [keyOf(task(971))], only_node: [keyOf(task(970))], only_derive: [keyOf(task(972))] },
    ])
  })
})

import type { DatabaseSync } from 'node:sqlite'
import type { LockReading } from '../../bus/db.js'
import type { CardStarter } from '../../bus/launch-executor.js'
import type { DetectionMode } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import type { IsolationReader } from '../../ports/isolation.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openBus, watchLocks } from '../../bus/db.js'
import { LAUNCH_ON, LaunchNode } from '../../bus/launch-worker.js'
import { NODE_CURSORS } from '../../bus/node.js'
import { keyOf, queueTask } from '../../bus/queue.js'
import { NODE_DETECTED, TASK_ENQUEUED } from '../../core/events.js'
import { Clock } from './github-fake.js'

const BUSY_EVENTS = 150_000
const SHORT_BUSY_TIMEOUT_MS = 200
const FILLER_CARDS = 20
const HOLD_LIMIT_MS = 1_000
const COMPUTES_PER_TICK = 1
const COMPUTES_PER_DELIVER = 1
const SUBSCRIBED = LAUNCH_ON[0]
const EVENT_CARD = 7_000

const OPEN_FILLER_CARDS = `
  SELECT cards.card_id FROM (SELECT DISTINCT card_id FROM events) AS cards
  WHERE NOT EXISTS (SELECT 1 FROM events AS later WHERE later.card_id = cards.card_id AND json_extract(later.payload, '$.index') = -1)
`

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })

const noLaunch: CardStarter = {
  start: () => {
    throw new Error('a deliver test starts no session')
  },
  stop: () => {},
}

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
  const root = mkdtempSync(path.join(tmpdir(), 'bus-deliver-lock-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

function shortWaits(...dbs: DatabaseSync[]): void {
  for (const db of dbs)
    db.exec(`PRAGMA busy_timeout = ${SHORT_BUSY_TIMEOUT_MS}`)
}

function fill(db: DatabaseSync, events: number): void {
  const insert = db.prepare(`INSERT INTO events (ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy) VALUES (?, 'probe.filler', 'netwatch', ?, ?, NULL, ?, ?, 0)`)
  db.exec('BEGIN IMMEDIATE')
  for (let index = 0; index < events; index++)
    insert.run('2026-10-23T00:00:00.000Z', 5_000 + (index % FILLER_CARDS), 4_000 + (index % FILLER_CARDS), `probe.filler:${index}`, JSON.stringify({ index, note: 'filler' }))
  db.exec('COMMIT')
}

function subscribed(db: DatabaseSync, count: number, from = 0): number[] {
  const insert = db.prepare(`INSERT INTO events (ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy) VALUES (?, ?, 'netwatch', ?, NULL, NULL, ?, '{}', 0) RETURNING id`)
  return Array.from({ length: count }, (_, index) => Number((insert.get('2026-10-23T00:00:00.000Z', SUBSCRIBED, EVENT_CARD + from + index, `probe.subscribed:${from + index}`) as { id: number }).id))
}

function subscribedOne(db: DatabaseSync, from: number): number {
  return subscribed(db, 1, from)[0] ?? 0
}

function task(cardId: number): QueuedTask {
  return { queue: 'launch', cardId, generation: `admission-${cardId}` }
}

class CountingLaunchNode extends LaunchNode {
  found: QueuedTask[] = []
  computes = 0
  computed: () => void = () => {}

  constructor(db: DatabaseSync, clock: Clock, mode: DetectionMode = 'shadow', session = 'deliver') {
    super({ db, starter: noLaunch, clock: clock.now, session, mode, env: {}, isolation: sandboxed, lanes: () => 1 })
  }

  protected override candidates(): QueuedTask[] {
    this.computes += 1
    this.db.prepare(OPEN_FILLER_CARDS).all()
    const found = this.found
    const computed = this.computed
    this.computed = () => {}
    computed()
    return found
  }

  protected override executes(): boolean {
    return false
  }
}

async function pass(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

async function opened(node: CountingLaunchNode): Promise<void> {
  await pass(node)
  node.computes = 0
}

function byEvent(db: DatabaseSync): { key: string, event_id: number }[] {
  return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(NODE_DETECTED) as { payload: string }[])
    .map(row => JSON.parse(row.payload) as { key: string, via: string, event_id: number })
    .filter(each => each.via === 'event')
    .map(({ key, event_id }) => ({ key, event_id }))
}

function cursorOf(db: DatabaseSync): number {
  return Number((db.prepare(`SELECT event_id FROM ${NODE_CURSORS} WHERE kind = 'launch'`).get() as { event_id: number }).event_id)
}

function lastId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
}

function holdsOf(db: DatabaseSync): number[] {
  const holds: number[] = []
  watchLocks(db, { now: () => performance.now(), observe: (reading: LockReading) => holds.push(reading.holdMs ?? 0) })
  return holds
}

describe('a launch deliver and the write lock', () => {
  it('a launch deliver of 50 matching events computes its candidates once', async () => {
    const db = openBus(busFile())
    const node = new CountingLaunchNode(db, new Clock())
    await opened(node)
    node.found = [task(970)]
    const events = subscribed(db, 50)
    await pass(node)

    expect(node.computes).toBe(COMPUTES_PER_DELIVER + COMPUTES_PER_TICK)
    expect(byEvent(db)).toEqual([{ key: keyOf(task(970)), event_id: events[0] }])
  })

  it('a launch deliver holds the write lock no longer than 1 s on a bus of 150k events', async () => {
    const db = openBus(busFile())
    fill(db, BUSY_EVENTS)
    const node = new CountingLaunchNode(db, new Clock())
    await opened(node)
    node.found = [task(970)]
    const events = subscribed(db, 10)
    const holds = holdsOf(db)
    await pass(node)

    expect(byEvent(db)).toEqual([{ key: keyOf(task(970)), event_id: events[0] }])
    expect(holds.length).toBeGreaterThan(0)
    expect(Math.max(...holds)).toBeLessThanOrEqual(HOLD_LIMIT_MS)
  }, 120_000)

  it('a launch deliver of a batch of 30 subscribed events holds the write lock no longer than 1 s and computes its candidates once', async () => {
    const db = openBus(busFile())
    fill(db, BUSY_EVENTS)
    const node = new CountingLaunchNode(db, new Clock())
    await opened(node)
    node.found = [task(970), task(971)]
    const events = subscribed(db, 30)
    const holds = holdsOf(db)
    await pass(node)

    expect(node.computes).toBe(COMPUTES_PER_DELIVER + COMPUTES_PER_TICK)
    expect(byEvent(db)).toEqual([{ key: keyOf(task(970)), event_id: events[0] }, { key: keyOf(task(971)), event_id: events[0] }])
    expect(Math.max(...holds)).toBeLessThanOrEqual(HOLD_LIMIT_MS)
  }, 120_000)

  it('a candidate another node took between computing and writing is not queued by deliver', async () => {
    const file = busFile()
    const db = openBus(file)
    const other = openBus(file)
    shortWaits(db, other)
    const clock = new Clock()
    const node = new CountingLaunchNode(db, clock, 'live')
    await opened(node)
    node.found = [task(970), task(972)]
    subscribed(db, 3)
    node.computed = () => {
      queueTask(other, clock.now().toISOString(), task(970))
    }
    await pass(node)

    expect(byEvent(db).map(each => each.key)).toEqual([keyOf(task(972))])
    expect((db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(TASK_ENQUEUED) as { payload: string }[]).map(row => (JSON.parse(row.payload) as { task_key: string }).task_key)).toEqual([keyOf(task(970)), keyOf(task(972))])
  })

  it('an event written while a batch is processed is delivered by the next pass and not lost', async () => {
    const file = busFile()
    const db = openBus(file)
    const other = openBus(file)
    shortWaits(db, other)
    const node = new CountingLaunchNode(db, new Clock())
    await opened(node)
    node.found = [task(970)]
    const first = subscribedOne(db, 0)
    let late = 0
    node.computed = () => {
      late = subscribedOne(other, 1)
    }
    await pass(node)

    expect(late).toBeGreaterThan(0)
    expect(byEvent(db)).toEqual([{ key: keyOf(task(970)), event_id: first }])
    expect(cursorOf(db)).toBeLessThan(late)

    node.found = [task(971)]
    await pass(node)
    expect(byEvent(db)).toEqual([{ key: keyOf(task(970)), event_id: first }, { key: keyOf(task(971)), event_id: late }])
    expect(cursorOf(db)).toBeGreaterThanOrEqual(late)
  })

  it('the cursor moves only together with the written results', async () => {
    const file = busFile()
    const db = openBus(file)
    const other = openBus(file)
    shortWaits(db, other)
    const node = new CountingLaunchNode(db, new Clock())
    await opened(node)
    node.found = [task(970)]
    subscribed(db, 2)
    let movedTo = 0
    node.computed = () => {
      movedTo = lastId(other)
      other.prepare(`UPDATE ${NODE_CURSORS} SET event_id = ? WHERE kind = 'launch'`).run(movedTo)
    }
    await pass(node)

    expect(movedTo).toBeGreaterThan(0)
    expect(byEvent(db)).toEqual([])
    expect(cursorOf(db)).toBe(movedTo)

    const before = cursorOf(db)
    const failing = subscribedOne(db, 2)
    db.exec(`CREATE TRIGGER fail_the_cursor BEFORE UPDATE ON ${NODE_CURSORS} BEGIN SELECT RAISE(ABORT, 'injected at the cursor'); END`)
    await expect(pass(node)).rejects.toThrow('injected at the cursor')
    expect(byEvent(db)).toEqual([])
    expect(cursorOf(db)).toBe(before)

    db.exec('DROP TRIGGER fail_the_cursor')
    await pass(node)
    expect(byEvent(db)).toEqual([{ key: keyOf(task(970)), event_id: failing }])
    expect(cursorOf(db)).toBeGreaterThanOrEqual(failing)
  })
})

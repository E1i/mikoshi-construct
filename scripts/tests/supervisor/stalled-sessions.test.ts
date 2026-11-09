import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { QueuedTask } from '../../core/queue.js'
import type { SessionLife } from '../../supervisor/recorded-worker.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_SESSION_ENDED, PR_OPENED, SESSION_HEARTBEAT, SESSION_STALLED } from '../../core/events.js'
import { leaseQueued } from '../../core/lease.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { NO_PROGRESS_LINES, StalledSessions } from '../../supervisor/stalled-sessions.js'

const LEASED_AT = Date.parse('2026-11-09T08:00:00.000Z')
const SESSION = 'session-under-watch'
const PUSHED_HEAD = 'a'.repeat(40)
const roots: string[] = []
const opened: DatabaseSync[] = []

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function at(minutes: number): Date {
  return new Date(LEASED_AT + minutes * 60_000)
}

function busWith(task: QueuedTask): { db: DatabaseSync, lease: Lease } {
  const root = mkdtempSync(path.join(tmpdir(), 'stalled-sessions-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  opened.push(db)
  queueTask(db, at(0).toISOString(), task)
  const lease = leaseQueued(db, at(0).toISOString(), keyOf(task), `worker:${task.queue}:worker-1`)!
  return { db, lease }
}

function beat(db: DatabaseSync, lease: Lease, minutes: number, context: number): void {
  appendEvent(db, { ts: at(minutes).toISOString(), type: SESSION_HEARTBEAT, actor: `worker:${lease.queue}:worker-1`, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${SESSION_HEARTBEAT}:${lease.taskKey}:${minutes}`, payload: { task_key: lease.taskKey, lease_gen: lease.leaseGen, session: SESSION, context }, legacy: false })
}

function watching(db: DatabaseSync, life: SessionLife): (minutes: number) => string[] {
  let now = at(0)
  const watch = new StalledSessions(db, () => now, { lifeOf: () => life })
  return (minutes) => {
    now = at(minutes)
    return watch.step()
  }
}

function payloadsOf(db: DatabaseSync, type: string): Record<string, unknown>[] {
  return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>)
}

function stateOf(db: DatabaseSync, lease: Lease): string {
  return (db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(lease.taskKey) as { state: string }).state
}

const LAUNCH: QueuedTask = { queue: 'launch', cardId: 1881, generation: 'g1' }
const launchLine = NO_PROGRESS_LINES.launch / 60_000

describe('the silent card and answer sessions', () => {
  it('a session expected to push with no push and no new step past the line is closed and requeued when its process is dead', () => {
    const { db, lease } = busWith(LAUNCH)
    beat(db, lease, 1, 1000)
    beat(db, lease, 5, 1000)
    const sweepAt = watching(db, 'dead')

    expect(sweepAt(launchLine)).toEqual([])
    expect(sweepAt(launchLine + 2)).toEqual([expect.stringContaining(`${lease.taskKey} is queued again`)])
    expect(payloadsOf(db, CARD_SESSION_ENDED)).toMatchObject([{ session: SESSION, stopped: true }])
    expect(stateOf(db, lease)).toBe('queued')
  })

  it('a live session with no progress past the line raises one window event with its reason', () => {
    const { db, lease } = busWith(LAUNCH)
    beat(db, lease, 1, 1000)
    beat(db, lease, 10, 1000)
    const sweepAt = watching(db, 'live')

    expect(sweepAt(launchLine + 2)).toEqual([expect.stringContaining('is alive but made no push and no new step')])
    expect(sweepAt(launchLine + 4)).toEqual([])
    expect(payloadsOf(db, SESSION_STALLED)).toMatchObject([{ task_key: lease.taskKey, session: SESSION, life: 'live', reason: expect.stringContaining(`card #${LAUNCH.cardId}`) }])
    expect(stateOf(db, lease)).toBe('leased')
  })

  it('a push after the lease moves the line to the push', () => {
    const { db, lease } = busWith(LAUNCH)
    beat(db, lease, 1, 1000)
    appendEvent(db, { ts: at(20).toISOString(), type: PR_OPENED, actor: 'worker:launch:worker-1', cardId: lease.cardId, pr: 7001, head: PUSHED_HEAD, dedupeKey: `${PR_OPENED}:${lease.taskKey}:${PUSHED_HEAD}`, payload: {}, legacy: false })
    const sweepAt = watching(db, 'dead')

    expect(sweepAt(launchLine + 2)).toEqual([])
    expect(stateOf(db, lease)).toBe('leased')
    expect(sweepAt(20 + launchLine + 2)).toEqual([expect.stringContaining(`${lease.taskKey} is queued again`)])
  })

  it('a heartbeat whose context grew moves the line to that beat', () => {
    const { db, lease } = busWith(LAUNCH)
    beat(db, lease, 1, 1000)
    beat(db, lease, 20, 4000)
    beat(db, lease, 40, 4000)
    const sweepAt = watching(db, 'live')

    expect(sweepAt(launchLine + 2)).toEqual([])
    expect(sweepAt(20 + launchLine + 2)).toEqual([expect.stringContaining('is alive but made no push and no new step')])
  })

  it('a session whose process table cannot be read raises the event and keeps the lease', () => {
    const { db, lease } = busWith(LAUNCH)
    beat(db, lease, 1, 1000)
    const sweepAt = watching(db, 'unknown')

    expect(sweepAt(launchLine + 2)).toEqual([expect.stringContaining('the process table could not be read')])
    expect(payloadsOf(db, SESSION_STALLED)).toMatchObject([{ session: SESSION, life: 'unknown' }])
    expect(payloadsOf(db, CARD_SESSION_ENDED)).toEqual([])
    expect(stateOf(db, lease)).toBe('leased')
  })

  it('a lease no heartbeat names a session for raises the event without asking the process table', () => {
    const { db, lease } = busWith(LAUNCH)
    let asked = 0
    let now = at(0)
    const watch = new StalledSessions(db, () => now, { lifeOf: () => {
      asked += 1
      return 'dead'
    } })
    now = at(launchLine + 2)

    expect(watch.step()).toEqual([expect.stringContaining('no heartbeat names its session')])
    expect(asked).toBe(0)
    expect(payloadsOf(db, SESSION_STALLED)).toMatchObject([{ session: null, life: 'unknown' }])
    expect(stateOf(db, lease)).toBe('leased')
  })
})

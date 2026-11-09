import type { DatabaseSync } from 'node:sqlite'
import type { BudgetLine } from '../../core/eddies.js'
import type { Lease } from '../../core/lease.js'
import type { QueuedTask } from '../../core/queue.js'
import type { SessionLife } from '../../supervisor/recorded-worker.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_SESSION_ENDED, SESSION_HEARTBEAT, SESSION_STALLED } from '../../core/events.js'
import { leaseQueued } from '../../core/lease.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { NO_PROGRESS_LINES, StalledSessions } from '../../supervisor/stalled-sessions.js'

const LEASED_AT = Date.parse('2026-11-09T08:00:00.000Z')
const SESSION = 'session-under-watch'
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

function beat(db: DatabaseSync, lease: Lease, minutes: number, context: number, spent = context): void {
  appendEvent(db, { ts: at(minutes).toISOString(), type: SESSION_HEARTBEAT, actor: `worker:${lease.queue}:worker-1`, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${SESSION_HEARTBEAT}:${lease.taskKey}:${minutes}`, payload: { task_key: lease.taskKey, lease_gen: lease.leaseGen, session: SESSION, context, spent }, legacy: false })
}

interface Watch {
  sweepAt: (minutes: number) => string[]
  stopped: string[]
}

function watching(db: DatabaseSync, life: SessionLife, spend: BudgetLine | null = null): Watch {
  let now = at(0)
  const stopped: string[] = []
  const watch = new StalledSessions(db, () => now, { lifeOf: () => life, stop: session => stopped.push(session), spendOf: () => spend })
  return {
    stopped,
    sweepAt: (minutes) => {
      now = at(minutes)
      return watch.step()
    },
  }
}

function payloadsOf(db: DatabaseSync, type: string): Record<string, unknown>[] {
  return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>)
}

function stateOf(db: DatabaseSync, lease: Lease): string {
  return (db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(lease.taskKey) as { state: string }).state
}

const LAUNCH: QueuedTask = { queue: 'launch', cardId: 1881, generation: 'g1' }
const REVIEW: QueuedTask = { queue: 'review', cardId: 1882, pr: 1882, head: 'a'.repeat(40) }
const launchLine = NO_PROGRESS_LINES.launch / 60_000
const reviewLine = NO_PROGRESS_LINES.review / 60_000

describe('the silent card and answer sessions', () => {
  it('a session expected to push with no push and no new step past the line is closed and requeued when its process is dead', () => {
    const { db, lease } = busWith(LAUNCH)
    beat(db, lease, 1, 1000)
    beat(db, lease, 5, 1000)
    const watch = watching(db, 'dead')

    expect(watch.sweepAt(launchLine)).toEqual([])
    expect(watch.sweepAt(launchLine + 2)).toEqual([expect.stringContaining(`${lease.taskKey} is queued again`)])
    expect(payloadsOf(db, CARD_SESSION_ENDED)).toMatchObject([{ session: SESSION, stopped: true }])
    expect(stateOf(db, lease)).toBe('queued')
  })

  it('a live session with no progress past the line raises one window event with its reason', () => {
    const { db, lease } = busWith(LAUNCH)
    beat(db, lease, 1, 1000)
    beat(db, lease, 10, 1000)
    const watch = watching(db, 'live')

    expect(watch.sweepAt(launchLine + 2)).toEqual([expect.stringContaining('is alive but made no push and no new step')])
    expect(watch.sweepAt(launchLine + 4)).toEqual([])
    expect(payloadsOf(db, SESSION_STALLED)).toMatchObject([{ task_key: lease.taskKey, session: SESSION, life: 'live', reason: expect.stringContaining(`card #${LAUNCH.cardId}`) }])
    expect(watch.stopped).toEqual([])
    expect(stateOf(db, lease)).toBe('leased')
  })

  it('a session whose spend reaches the limit is stopped with a window event naming the spend', () => {
    const { db, lease } = busWith(LAUNCH)
    beat(db, lease, 1, 1000)
    const spend: BudgetLine = { event: 'budget-stop', level: 'session-spend', spent: 41.5, limit: 40, tool: null, at: at(2).toISOString(), session: SESSION }
    const watch = watching(db, 'live', spend)

    expect(watch.sweepAt(2)).toEqual([expect.stringContaining('spent 41.5 against the Eddies limit 40')])
    expect(watch.stopped).toEqual([SESSION])
    expect(payloadsOf(db, SESSION_STALLED)).toMatchObject([{ spent: 41.5, limit: 40, stopped: true }])
  })
})

describe('the silent review sessions', () => {
  it('a review session with no new step and no output past the no-progress line is ended at that line, before its ceiling', () => {
    const { db, lease } = busWith(REVIEW)
    beat(db, lease, 1, 5000)
    const watch = watching(db, 'live')

    expect(watch.sweepAt(reviewLine + 1)).toEqual([expect.stringContaining('ended before its ceiling')])
    expect(watch.stopped).toEqual([SESSION])
    expect(reviewLine).toBeLessThan(20)
  })

  it('a review session that keeps making steps is not ended before its ceiling', () => {
    const { db, lease } = busWith(REVIEW)
    const watch = watching(db, 'live')
    for (let minute = 1; minute < 19; minute++) {
      beat(db, lease, minute, 5000 + minute * 100)
      expect(watch.sweepAt(minute + 0.5)).toEqual([])
    }
    expect(watch.stopped).toEqual([])
  })

  it('a review session whose context does not grow past the no-progress line is ended there although its heartbeat is alive', () => {
    const { db, lease } = busWith(REVIEW)
    const watch = watching(db, 'live')
    beat(db, lease, 1, 62659)
    for (let minute = 2; minute <= reviewLine + 1; minute++)
      beat(db, lease, minute, 62659)

    expect(watch.sweepAt(reviewLine + 1.5)).toEqual([expect.stringContaining('its context did not grow')])
    expect(watch.stopped).toEqual([SESSION])
  })
})

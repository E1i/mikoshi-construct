import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { QueuedTask } from '../../core/queue.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { SESSION_HEARTBEAT, SESSION_STALLED, TASK_FAILED } from '../../core/events.js'
import { failTask, leaseQueued } from '../../core/lease.js'
import { keyOf, queueTask } from '../../core/queue.js'
import { REVIEW_CEILING_MS } from '../../nodes/review/reviewer.js'
import { InMemoryProcessTable } from '../../ports/process-table.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { NO_PROGRESS_LINES, pulseIn, StalledSessions, transcriptMoved } from '../../supervisor/stalled-sessions.js'

const LEASED_AT = Date.parse('2026-11-10T08:00:00.000Z')
const SESSION = 'review-under-watch'
const REVIEW: QueuedTask = { queue: 'review', cardId: 1787, pr: 1527, head: 'c'.repeat(40) }
const reviewLine = NO_PROGRESS_LINES.review / 60_000
const reviewCeiling = REVIEW_CEILING_MS / 60_000
const STILL_CONTEXT = 62659
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

function busWithReview(): { db: DatabaseSync, lease: Lease } {
  const root = mkdtempSync(path.join(tmpdir(), 'review-stall-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  opened.push(db)
  queueTask(db, at(0).toISOString(), REVIEW)
  return { db, lease: leaseQueued(db, at(0).toISOString(), keyOf(REVIEW), 'worker:review:worker-1')! }
}

function beat(db: DatabaseSync, lease: Lease, minutes: number, gauges: { context: number, spent?: number, subagents?: { agent: string, spent: number }[] }): void {
  appendEvent(db, { ts: at(minutes).toISOString(), type: SESSION_HEARTBEAT, actor: 'worker:review:worker-1', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${SESSION_HEARTBEAT}:${lease.taskKey}:${lease.leaseGen}:${minutes}`, payload: { task_key: lease.taskKey, lease_gen: lease.leaseGen, session: SESSION, ...gauges }, legacy: false })
}

interface Watch {
  sweepAt: (minutes: number) => string[]
  stopped: string[]
}

function watching(db: DatabaseSync, pulseAt: (minutes: number) => string | null): Watch {
  let minutesNow = 0
  const stopped: string[] = []
  const watch = new StalledSessions(db, () => at(minutesNow), { lifeOf: () => 'live', stop: session => stopped.push(session), spendOf: () => null, pulseOf: () => pulseAt(minutesNow) })
  return {
    stopped,
    sweepAt: (minutes) => {
      minutesNow = minutes
      return watch.step()
    },
  }
}

function stalledReasons(db: DatabaseSync): string[] {
  return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(SESSION_STALLED) as { payload: string }[]).map(row => (JSON.parse(row.payload) as { reason: string }).reason)
}

function stateOf(db: DatabaseSync, lease: Lease): string {
  return (db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(lease.taskKey) as { state: string }).state
}

describe('a review session judged on more than one signal', () => {
  it('a review session whose transcript grows with an unchanged context reading is not ended', () => {
    const { db, lease } = busWithReview()
    const watch = watching(db, () => '4100')
    for (let minute = 1; minute < reviewCeiling; minute++) {
      beat(db, lease, minute, { context: STILL_CONTEXT, spent: 1.5 + minute * 0.25 })
      expect(watch.sweepAt(minute + 0.5)).toEqual([])
    }
    expect(watch.stopped).toEqual([])
    expect(stalledReasons(db)).toEqual([])
    expect(stateOf(db, lease)).toBe('leased')
  })

  it('a live review session whose only stale signal is the context reading is not sent SIGTERM', () => {
    const { db, lease } = busWithReview()
    const watch = watching(db, () => null)
    for (let minute = 1; minute <= reviewLine + 1; minute++)
      beat(db, lease, minute, { context: STILL_CONTEXT })

    expect(watch.sweepAt(reviewLine + 1.5)).toEqual([expect.stringContaining('one stale signal stops nothing')])
    expect(watch.stopped).toEqual([])
    expect(stalledReasons(db)).toEqual([expect.stringContaining('only context stood still')])
    expect(stateOf(db, lease)).toBe('leased')
  })

  it('a review session whose process keeps moving while its context stands still is not stopped', () => {
    const { db, lease } = busWithReview()
    const watch = watching(db, minutes => `4100,${4200 + Math.floor(minutes)}`)
    for (let minute = 1; minute < reviewCeiling; minute++) {
      beat(db, lease, minute, { context: STILL_CONTEXT })
      expect(watch.sweepAt(minute + 0.5)).toEqual([])
    }
    expect(watch.stopped).toEqual([])
  })

  it('a review ended by the stall line twice on one head is not requeued the same way', () => {
    const { db, lease } = busWithReview()
    const watch = watching(db, () => '4100')
    beat(db, lease, 1, { context: STILL_CONTEXT })
    expect(watch.sweepAt(1)).toEqual([])
    expect(watch.sweepAt(reviewLine + 2)).toEqual([expect.stringContaining('ended before its ceiling')])
    expect(watch.stopped).toEqual([SESSION])
    expect(watch.sweepAt(reviewLine + 3)).toEqual([])
    expect(watch.stopped).toEqual([SESSION])
    expect(stateOf(db, lease)).toBe('leased')

    failTask(db, at(reviewLine + 3).toISOString(), lease, { reason: 'exit 143', withdraw: false }, SILENT_MS)
    const again = leaseQueued(db, at(reviewLine + 4).toISOString(), keyOf(REVIEW), 'worker:review:worker-1')!
    expect(again.leaseGen).toBeGreaterThan(lease.leaseGen)
    beat(db, again, reviewLine + 5, { context: STILL_CONTEXT })
    expect(watch.sweepAt(reviewLine + 5)).toEqual([])
    const second = watch.sweepAt(2 * reviewLine + 6)

    expect(second).toEqual([expect.stringContaining('not queued a third time the same way')])
    expect(second[0]).toContain('by slices')
    expect(watch.stopped).toEqual([SESSION, SESSION])
    expect(stateOf(db, again)).toBe('withdrawn')
    const withdrawn = db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(TASK_FAILED) as { payload: string } | undefined
    expect(JSON.parse(withdrawn?.payload ?? '{}')).toMatchObject({ reason: 'review_stalled_twice', next: 'withdrawn' })
  })

  it('a live review session that stays live past the next sweep after its first end is not withdrawn on that one run', () => {
    const { db, lease } = busWithReview()
    const watch = watching(db, () => '4100')
    beat(db, lease, 1, { context: STILL_CONTEXT })
    expect(watch.sweepAt(1)).toEqual([])
    expect(watch.sweepAt(reviewLine + 2)).toEqual([expect.stringContaining('ended before its ceiling')])
    for (let minute = reviewLine + 3; minute < reviewCeiling; minute++)
      expect(watch.sweepAt(minute)).toEqual([])

    expect(watch.stopped).toEqual([SESSION])
    expect(stateOf(db, lease)).toBe('leased')
  })

  it('a live review session with only its context readable is never stopped before its ceiling', () => {
    const { db, lease } = busWithReview()
    const watch = watching(db, () => null)
    const raised: string[] = []
    for (let minute = 1; minute < reviewCeiling; minute++) {
      beat(db, lease, minute, { context: STILL_CONTEXT })
      raised.push(...watch.sweepAt(minute + 0.5))
    }

    expect(watch.stopped).toEqual([])
    expect(raised).toEqual([expect.stringContaining('one stale signal stops nothing')])
    expect(stateOf(db, lease)).toBe('leased')
  })

  it('a review whose subagents grow while its own spend and context stand still keeps moving', () => {
    const { db, lease } = busWithReview()
    const watch = watching(db, () => '4100')
    for (let minute = 1; minute < reviewCeiling; minute++) {
      beat(db, lease, minute, { context: STILL_CONTEXT, spent: 12.5, subagents: [{ agent: 'scan', spent: minute }] })
      expect(watch.sweepAt(minute + 0.5)).toEqual([])
    }
    expect(watch.stopped).toEqual([])
  })
})

describe('the readings the stall line judges on', () => {
  it('the transcript moves when only the subagents reading changes', () => {
    const leasedAt = at(0).toISOString()
    const moved = transcriptMoved(leasedAt, [
      { ts: at(1).toISOString(), spent: 3, subagents: '[{"spent":1}]' },
      { ts: at(5).toISOString(), spent: 3, subagents: '[{"spent":2}]' },
      { ts: at(9).toISOString(), spent: 3, subagents: '[{"spent":2}]' },
    ])
    expect(moved).toEqual({ readable: true, at: at(5).toISOString() })
  })

  it('a heartbeat with no spend reading leaves the transcript unreadable', () => {
    expect(transcriptMoved(at(0).toISOString(), [{ ts: at(1).toISOString(), spent: null, subagents: null }])).toEqual({ readable: false, at: at(0).toISOString() })
  })

  it('the process pulse of a session covers its descendants, not only the process naming it', () => {
    const row = (pid: number, ppid: number, command: string) => ({ pid, ppid, pgid: pid, started: 'Tue Nov 10 08:00:00 2026', command })
    const before = new InMemoryProcessTable({ rows: [row(1, 0, 'launchd'), row(4100, 1, `client --session ${SESSION}`), row(4200, 4100, 'node vitest'), row(4300, 4200, 'node worker'), row(5000, 1, 'other')] })
    const after = new InMemoryProcessTable({ rows: [row(1, 0, 'launchd'), row(4100, 1, `client --session ${SESSION}`), row(4200, 4100, 'node vitest'), row(4301, 4200, 'node worker'), row(5000, 1, 'other')] })

    expect(pulseIn(before)(SESSION)).toBe('4100,4200,4300')
    expect(pulseIn(after)(SESSION)).not.toBe(pulseIn(before)(SESSION))
  })

  it('a session no process names, or a table that cannot be read, has no pulse', () => {
    expect(pulseIn(new InMemoryProcessTable({ rows: [] }))(SESSION)).toBeNull()
    expect(pulseIn(new InMemoryProcessTable({ rows: { unreadable: 'ps refused' } }))(SESSION)).toBeNull()
  })
})

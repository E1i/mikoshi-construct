import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { NetWatch, TICK_MS } from '../../bus/netwatch.js'
import { queueTask, TASK_QUEUED, TASK_SUPERSEDED } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { BusTick } from '../../bus/run.js'
import { Clock, FakeGitHub, sha } from './github-fake.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function setUp(): { db: DatabaseSync, gitHub: FakeGitHub, tick: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-review-queue-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const busTick = new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now)
  let first = true
  const tick = (): void => {
    if (!first)
      clock.advance(TICK_MS)
    first = false
    busTick.run()
  }
  return { db, gitHub, tick }
}

function tasks(db: DatabaseSync): { task_key: string, state: string }[] {
  return db.prepare('SELECT task_key, state FROM tasks ORDER BY id').all() as { task_key: string, state: string }[]
}

function taskEvents(db: DatabaseSync): { type: string, dedupe_key: string }[] {
  return db.prepare(`SELECT type, dedupe_key FROM events WHERE type LIKE 'task.%' ORDER BY id`).all() as { type: string, dedupe_key: string }[]
}

const review = (pr: number, head: string): string => taskKey({ queue: 'review', cardId: pr + 100, pr, head })

describe('review queue', () => {
  it('a pr with a new head and no verdict enters review within 2 ticks', () => {
    const { db, gitHub, tick } = setUp()
    gitHub.open({ number: 920 })
    tick()
    expect(tasks(db)).toEqual([{ task_key: review(920, sha('a')), state: 'queued' }])

    gitHub.open({ number: 920, head: sha('b') })
    let ticks = 0
    while (ticks < 2 && !tasks(db).some(task => task.task_key === review(920, sha('b')))) {
      tick()
      ticks += 1
    }
    expect(tasks(db)).toContainEqual({ task_key: review(920, sha('b')), state: 'queued' })
    db.close()
  })

  it('tasks of the old head become superseded on a new head', () => {
    const { db, gitHub, tick } = setUp()
    gitHub.open({ number: 921 })
    gitHub.open({ number: 922 })
    tick()
    gitHub.open({ number: 921, head: sha('c') })
    tick()

    expect(tasks(db)).toEqual([
      { task_key: review(921, sha('a')), state: 'superseded' },
      { task_key: review(922, sha('a')), state: 'queued' },
      { task_key: review(921, sha('c')), state: 'queued' },
    ])
    expect(taskEvents(db).filter(event => event.type === TASK_SUPERSEDED).map(event => event.dedupe_key)).toEqual([`${TASK_SUPERSEDED}:${review(921, sha('a'))}`])
    const live = projectionDump(db)
    reduce(db)
    expect(projectionDump(db)).toBe(live)
    tick()
    expect(taskEvents(db)).toHaveLength(4)
    db.close()
  })

  it('a task row and its task.* event are written in one transaction', () => {
    const { db } = setUp()
    const task = { queue: 'review' as const, cardId: 1023, pr: 923, head: sha('d') }
    db.exec(`CREATE TRIGGER no_task_rows BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'no task rows'); END;`)
    expect(() => queueTask(db, '2026-10-09T12:00:00.000Z', task)).toThrow(/no task rows/)
    expect(taskEvents(db)).toEqual([])

    db.exec(`DROP TRIGGER no_task_rows; CREATE TRIGGER no_task_events BEFORE INSERT ON events WHEN NEW.type LIKE 'task.%' BEGIN SELECT RAISE(ABORT, 'no task events'); END;`)
    expect(() => queueTask(db, '2026-10-09T12:00:00.000Z', task)).toThrow(/no task events/)
    expect(tasks(db)).toEqual([])

    db.exec('DROP TRIGGER no_task_events')
    expect(queueTask(db, '2026-10-09T12:00:00.000Z', task)).toBe(true)
    const row = db.prepare('SELECT event_id FROM tasks').get() as { event_id: number }
    expect(db.prepare('SELECT type, dedupe_key FROM events WHERE id = ?').get(row.event_id)).toEqual({ type: TASK_QUEUED, dedupe_key: `${TASK_QUEUED}:${taskKey(task)}` })
    expect(queueTask(db, '2026-10-09T12:01:00.000Z', task)).toBe(false)
    expect(taskEvents(db)).toHaveLength(1)
    db.close()
  })

  it('a new head without a status or verdict returns to review and the old head tasks are superseded', () => {
    const { db, gitHub, tick } = setUp()
    gitHub.open({ number: 924 })
    tick()
    gitHub.open({ number: 924, review: 'success' })
    tick()
    expect(tasks(db)).toEqual([{ task_key: review(924, sha('a')), state: 'queued' }])

    gitHub.open({ number: 924, head: sha('e'), required: 'pending' })
    tick()
    expect(tasks(db)).toEqual([{ task_key: review(924, sha('a')), state: 'superseded' }])

    gitHub.open({ number: 924, head: sha('e') })
    tick()
    expect(tasks(db)).toEqual([
      { task_key: review(924, sha('a')), state: 'superseded' },
      { task_key: review(924, sha('e')), state: 'queued' },
    ])
    db.close()
  })
})

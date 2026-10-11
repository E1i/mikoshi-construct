import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { prBodySha, taskKey } from '../../bus/identifiers.js'
import { importJournal } from '../../bus/import.js'
import { NetWatch, TICK_MS } from '../../bus/netwatch.js'
import { queueTask, TASK_SUPERSEDED } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { fullReview } from '../../bus/review-depth.js'
import { REVIEW_RECORDED, ReviewWorker } from '../../bus/review-worker.js'
import { BusTick } from '../../bus/run.js'
import { cardBody, Clock, FakeGitHub, sha } from './github-fake.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function setUp(): { db: DatabaseSync, gitHub: FakeGitHub, clock: Clock, tick: () => void } {
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
  return { db, gitHub, clock, tick }
}

function tasks(db: DatabaseSync): { task_key: string, state: string }[] {
  return db.prepare('SELECT task_key, state FROM tasks ORDER BY id').all() as { task_key: string, state: string }[]
}

function taskEvents(db: DatabaseSync): { type: string, dedupe_key: string }[] {
  return db.prepare(`SELECT type, dedupe_key FROM events WHERE type LIKE 'task.%' ORDER BY id`).all() as { type: string, dedupe_key: string }[]
}

const review = (pr: number, head: string): string => taskKey({ queue: 'review', cardId: pr + 100, pr, head, input: { prBody: prBodySha(cardBody(pr)), cardBody: null } })

function intakeLine(cardId: number, bodySha: string): string {
  return JSON.stringify({ event: 'intake', task: String(cardId), card: `#${cardId} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —`, confirmation: 'auto', corrections: [], bodySha, source: 'admit', ts: '2026-10-11T14:00:00.000Z' })
}

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
    expect(db.prepare('SELECT type, dedupe_key FROM events WHERE id = ?').get(row.event_id)).toEqual({ type: 'task.enqueued', dedupe_key: `task.enqueued:${taskKey(task)}` })
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
    const merge = taskKey({ queue: 'merge', cardId: 1024, pr: 924, head: sha('a') })
    expect(tasks(db)).toEqual([{ task_key: review(924, sha('a')), state: 'queued' }, { task_key: merge, state: 'queued' }])

    gitHub.open({ number: 924, head: sha('e'), required: 'pending' })
    tick()
    expect(tasks(db)).toEqual([{ task_key: review(924, sha('a')), state: 'superseded' }, { task_key: merge, state: 'superseded' }])

    gitHub.open({ number: 924, head: sha('e') })
    tick()
    expect(tasks(db)).toEqual([
      { task_key: review(924, sha('a')), state: 'superseded' },
      { task_key: merge, state: 'superseded' },
      { task_key: review(924, sha('e')), state: 'queued' },
    ])
    db.close()
  })

  it('an edit of the pull request body or of the card body after changes on head X gives a new review.recorded on X with no new commit', async () => {
    const { db, gitHub, clock, tick } = setUp()
    const body = cardBody(925)
    const worker = new ReviewWorker({
      db,
      gitHub: gitHub.client,
      publish: (status) => {
        gitHub.pulls.get(925)!.review = status.state
      },
      reviewer: async () => ({ verdict: 'changes', findings: ['the pull request body names no ladder reason'], session: 'reviewer-1' }),
      plan: () => fullReview('a fixed plan'),
      clock: clock.now,
      session: 'worker-1',
    })
    const recorded = (): { head: string, task: string }[] => (db.prepare(`SELECT head, dedupe_key FROM events WHERE type = '${REVIEW_RECORDED}' ORDER BY id`).all() as { head: string, dedupe_key: string }[]).map(row => ({ head: row.head, task: row.dedupe_key.split(':').slice(1, -1).join(':') }))
    const keyOf = (prBody: string, card: string | null): string => taskKey({ queue: 'review', cardId: 1025, pr: 925, head: sha('a'), input: { prBody: prBodySha(prBody), cardBody: card } })

    gitHub.open({ number: 925, body })
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes', taskKey: keyOf(body, null) })
    tick()
    tick()
    expect(await worker.step()).toEqual({ kind: 'idle' })

    const edited = `${body}\n\nThe ladder: MORSE predicts ladder by rule doubt.`
    gitHub.open({ number: 925, body: edited, review: 'failure' })
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', taskKey: keyOf(edited, null) })
    tick()
    expect(await worker.step()).toEqual({ kind: 'idle' })

    importJournal(db, intakeLine(1025, '0123abcd4567ef89'))
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', taskKey: keyOf(edited, '0123abcd4567ef89') })
    tick()
    expect(await worker.step()).toEqual({ kind: 'idle' })

    expect(recorded()).toEqual([
      { head: sha('a'), task: keyOf(body, null) },
      { head: sha('a'), task: keyOf(edited, null) },
      { head: sha('a'), task: keyOf(edited, '0123abcd4567ef89') },
    ])
    expect(gitHub.pulls.get(925)!.head).toBe(sha('a'))
    const live = projectionDump(db)
    reduce(db)
    expect(projectionDump(db)).toBe(live)
    db.close()
  })

  it('a review queued under one body is superseded when the body changes before it runs', () => {
    const { db, gitHub, tick } = setUp()
    const body = cardBody(926)
    const edited = `${body}\n\nedited`
    gitHub.open({ number: 926, body })
    tick()
    gitHub.open({ number: 926, body: edited })
    tick()
    const keyOf = (prBody: string): string => taskKey({ queue: 'review', cardId: 1026, pr: 926, head: sha('a'), input: { prBody: prBodySha(prBody), cardBody: null } })
    expect(tasks(db)).toEqual([{ task_key: keyOf(body), state: 'superseded' }, { task_key: keyOf(edited), state: 'queued' }])
    db.close()
  })
})

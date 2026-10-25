import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../core/db.js'
import { Buffer } from 'node:buffer'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { prBodySha, taskKey } from '../../core/identifiers.js'
import { completeTask, leaseNext } from '../../core/lease.js'
import { deriveQueues, queueTask, reviewCandidates, reviewKeysOfAnOldInput, reviewKeysOfTheCurrentInputAgain } from '../../core/queue.js'
import { projectionDump, reduce } from '../../core/reducer.js'

const HEADS = ['0123456789abcdef0123456789abcdef01234567', '89abcdef0123456789abcdef0123456789abcdef']
const MAIN = 'fedcba9876543210fedcba9876543210fedcba98'
const roots: string[] = []
const WITNESS = 'a replay of the whole live journal on a copy of bus.db after the review-key format change gives the same projection as before, and review tasks with old keys are neither duplicated nor lost'

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-replay-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function live(type: string, dedupeKey: string, fields: Partial<BusEvent>): BusEvent {
  return { ts: '2026-10-09T12:00:00.000Z', type, actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey, payload: {}, legacy: false, ...fields }
}

function observed(pr: number, cardId: number, head: string, ci: string): BusEvent {
  return live('pr.observed', `pr:${pr}:${head}:${ci}`, { pr, cardId, head, payload: { base: 'main', head, mergeable: 'clean', ci, auto_merge: false, draft: false } })
}

const LOG: BusEvent[] = [
  { ...observed(799, 790, HEADS[0]!, 'green'), actor: null, legacy: true, dedupeKey: 'legacy:1' },
  observed(800, 793, HEADS[0]!, 'pending'),
  observed(801, 794, HEADS[0]!, 'green'),
  live('pr.opened', 'pr.opened:795', { actor: 'worker:launch:s1', cardId: 795, payload: { pr: 802 } }),
  observed(800, 793, HEADS[1]!, 'green'),
  live('pr.closed', 'pr:801:closed', { pr: 801, payload: { merged: true, commit: MAIN } }),
  live('main.advanced', `main:${MAIN}`, { payload: { sha: MAIN, touches_mechanics: true } }),
  live('pr.opened', 'pr.opened:793', { actor: 'worker:launch:s2', cardId: 793, payload: { pr: 803 } }),
  live('pr.closed', 'pr:804:closed', { pr: 804, payload: { merged: false } }),
  live('card.started', 'card.started:796', { actor: 'worker:launch:s3', cardId: 796, payload: { session: 's3' } }),
  observed(802, 795, HEADS[1]!, 'red'),
]

function replayedFromEmpty(log: readonly { [key: string]: unknown }[]): string {
  const db = newBus()
  for (const row of log) {
    db.prepare(`INSERT INTO events (id, ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id as number, row.ts as string | null, row.type as string, row.actor as string | null, row.card_id as number | null, row.pr as number | null, row.head as string | null, row.dedupe_key as string, row.payload as string, row.legacy as number)
  }
  reduce(db)
  const dump = projectionDump(db)
  db.close()
  return dump
}

function expectReplayKeepsOldReviews(copy: DatabaseSync): void {
  reduce(copy)
  const folded = projectionDump(copy)
  const oldReviews = copy.prepare(`SELECT tasks.task_key, tasks.state, tasks.head, prs.head AS pr_head FROM tasks LEFT JOIN prs ON prs.pr = tasks.pr WHERE tasks.queue = 'review' ORDER BY tasks.task_key`).all() as { task_key: string, state: string, head: string | null, pr_head: string | null }[]
  reduce(copy)
  expect(projectionDump(copy)).toBe(folded)

  const ofAnOldInput = new Set(reviewKeysOfAnOldInput(copy))
  const ofTheCurrentInputAgain = new Set(reviewKeysOfTheCurrentInputAgain(copy))
  deriveQueues(copy, '2026-10-11T17:30:00.000Z')
  const after = new Map((copy.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'review'`).all() as { task_key: string, state: string }[]).map(row => [row.task_key, row.state]))
  for (const old of oldReviews) {
    const leftBehind = (old.state === 'queued' || old.state === 'leased') && (old.head !== old.pr_head || ofAnOldInput.has(old.task_key))
    const expected = leftBehind ? 'superseded' : ofTheCurrentInputAgain.has(old.task_key) ? 'queued' : old.state
    expect({ key: old.task_key, state: after.get(old.task_key) }).toEqual({ key: old.task_key, state: expected })
  }
  expect(copy.prepare(`SELECT pr FROM tasks WHERE queue = 'review' AND state IN ('queued', 'leased') GROUP BY pr HAVING count(*) > 1`).all()).toEqual([])
}

describe('replay determinism', () => {
  it('replaying the log from empty twice gives byte-identical prs, cards and tasks dumps', () => {
    const source = newBus()
    for (const each of LOG)
      appendEvent(source, each)
    reduce(source)
    const live = projectionDump(source)
    const log = source.prepare('SELECT * FROM events ORDER BY id').all()
    source.close()

    const first = replayedFromEmpty(log)
    const second = replayedFromEmpty(log)
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true)
    expect(first).toBe(live)
    const dump = JSON.parse(first) as { prs: unknown[], cards: unknown[], tasks: unknown[] }
    expect(dump.prs).toHaveLength(3)
    expect(dump.cards).toHaveLength(3)
  })

  it('a replay of the events alone, without the rejections the reducer wrote, rebuilds the same projections', () => {
    const source = newBus()
    for (const each of LOG)
      appendEvent(source, each)
    reduce(source)
    const live = projectionDump(source)
    const log = source.prepare(`SELECT * FROM events WHERE type != 'reducer.rejected' ORDER BY id`).all()
    expect(log.length).toBeLessThan((source.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n)
    source.close()

    expect(replayedFromEmpty(log)).toBe(live)
  })

  it(WITNESS, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-replay-'))
    roots.push(root)
    const liveFile = path.join(root, 'bus.db')
    const source = openBus(liveFile)
    for (const each of LOG)
      appendEvent(source, each)
    const prs = [930, 931, 932]
    for (const pr of prs)
      appendEvent(source, observed(pr, pr - 100, HEADS[0]!, 'green'))
    reduce(source)
    const oldKeys = prs.map(pr => taskKey({ queue: 'review', cardId: pr - 100, pr, head: HEADS[0]! }))
    queueTask(source, '2026-10-09T12:00:30.000Z', { queue: 'review', cardId: 832, pr: 932, head: HEADS[0]! })
    completeTask(source, '2026-10-09T12:00:40.000Z', leaseNext(source, '2026-10-09T12:00:35.000Z', 'review', 'worker:review:s0')!, [])
    for (const pr of [930, 931])
      queueTask(source, '2026-10-09T12:01:00.000Z', { queue: 'review', cardId: pr - 100, pr, head: HEADS[0]! })
    expect(leaseNext(source, '2026-10-09T12:02:00.000Z', 'review', 'worker:review:s1')?.taskKey).toBe(oldKeys[0])
    source.exec('ALTER TABLE prs DROP COLUMN body_sha')
    source.close()
    const copyFile = path.join(root, 'bus-copy.db')
    copyFileSync(liveFile, copyFile)

    const copy = openBus(copyFile)
    const before = projectionDump(copy)
    reduce(copy)
    expect(projectionDump(copy)).toBe(before)

    for (const pr of prs)
      appendEvent(copy, { ...observed(pr, pr - 100, HEADS[0]!, 'green'), dedupeKey: `pr:${pr}:${HEADS[0]!}:green:body`, payload: { base: 'main', head: HEADS[0]!, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, body_sha: prBodySha(`card: #${pr - 100}`) } })
    reduce(copy)
    deriveQueues(copy, '2026-10-09T12:03:00.000Z')
    const live = copy.prepare(`SELECT pr, head, count(*) AS n FROM tasks WHERE queue = 'review' AND state IN ('queued', 'leased') GROUP BY pr, head HAVING n > 1`).all()
    expect(live).toEqual([])
    const reviews = copy.prepare(`SELECT task_key, pr, state FROM tasks WHERE queue = 'review' AND pr IN (930, 931, 932) ORDER BY pr, id`).all()
    expect(reviews).toEqual([
      { task_key: oldKeys[0], pr: 930, state: 'leased' },
      { task_key: oldKeys[1], pr: 931, state: 'queued' },
      { task_key: oldKeys[2], pr: 932, state: 'completed' },
    ])
    const settled = projectionDump(copy)
    reduce(copy)
    expect(projectionDump(copy)).toBe(settled)
    copy.close()
  })

  it(`${WITNESS}, on a VACUUM INTO snapshot of a bus that holds events`, () => {
    const source = newBus()
    appendEvent(source, observed(960, 860, HEADS[0]!, 'green'))
    reduce(source)
    const root = mkdtempSync(path.join(tmpdir(), 'bus-replay-snapshot-'))
    roots.push(root)
    const snapshot = path.join(root, 'bus.db')
    source.prepare('VACUUM INTO ?').run(snapshot)
    source.close()

    const copy = openBus(snapshot)
    expect(copy.prepare('SELECT count(*) AS events FROM events').get()).not.toEqual({ events: 0 })
    expectReplayKeepsOldReviews(copy)
    copy.close()
  })

  it('a snapshot taken after a body edit was folded and before the tick derived its queues counts the input-keyed review of the old body as left behind', () => {
    const copy = newBus()
    const head = HEADS[0]!
    const body = (text: string): BusEvent => ({ ...observed(950, 850, head, 'green'), dedupeKey: `pr:950:${text}`, payload: { base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, body_sha: prBodySha(text) } })
    appendEvent(copy, body('card: #850'))
    reduce(copy)
    for (const task of reviewCandidates(copy, '2026-10-11T17:00:00.000Z'))
      queueTask(copy, '2026-10-11T17:00:00.000Z', task)
    const first = taskKey({ queue: 'review', cardId: 850, pr: 950, head, input: { prBody: prBodySha('card: #850'), cardBody: null } })
    expect(copy.prepare(`SELECT state FROM tasks WHERE task_key = ?`).get(first)).toEqual({ state: 'queued' })
    appendEvent(copy, body('card: #850 edited'))
    reduce(copy)

    expectReplayKeepsOldReviews(copy)
    expect(copy.prepare(`SELECT state FROM tasks WHERE task_key = ?`).get(first)).toEqual({ state: 'superseded' })
    copy.close()
  })
})

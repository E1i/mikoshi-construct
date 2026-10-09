import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../bus/lease.js'
import type { Reviewer } from '../../bus/reviewer.js'
import type { ReviewStatus, StatusPublisher } from '../../ghosts/verdict.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { importJournal } from '../../bus/import.js'
import { ownerInbox } from '../../bus/inbox.js'
import { completeTask, expireLeases, failTask, LEASE_MS, leaseNext, renewLease, StaleLease } from '../../bus/lease.js'
import { NetWatch, TICK_MS } from '../../bus/netwatch.js'
import { authorSessions } from '../../bus/record-verdict.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { DRY_RUN_ACTOR, dryRun, RENEW_MS, reviewMode, ReviewWorker, ShadowNotClean, startReviewWorker } from '../../bus/review-worker.js'
import { BusTick } from '../../bus/run.js'
import { Clock, FakeGitHub, sha } from './github-fake.js'

const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Bench {
  db: DatabaseSync
  gitHub: FakeGitHub
  clock: Clock
  statuses: ReviewStatus[]
  tick: () => void
  worker: (reviewer: Reviewer, publish?: StatusPublisher) => ReviewWorker
}

function setUp(): Bench {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-review-worker-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const busTick = new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now)
  const statuses: ReviewStatus[] = []
  const posted: StatusPublisher = (status) => {
    statuses.push(status)
    const pull = [...gitHub.pulls.values()].find(candidate => candidate.head === status.commit)
    if (pull !== undefined)
      pull.review = status.state
  }
  return {
    db,
    gitHub,
    clock,
    statuses,
    tick: () => {
      busTick.run()
      clock.advance(TICK_MS)
    },
    worker: (reviewer, publish = posted) => new ReviewWorker({ db, gitHub: gitHub.client, publish, reviewer, clock: clock.now, session: 'worker-1' }),
  }
}

const reviewing = (session = 'reviewer-1', verdict: 'pass' | 'changes' = 'pass'): Reviewer => async () => ({ verdict, findings: verdict === 'pass' ? [] : ['a finding'], session })

const unreachable: StatusPublisher = () => {
  throw new Error('gh api: HTTP 502 Bad Gateway')
}

const review = (pr: number, head = sha('a')): string => taskKey({ queue: 'review', cardId: pr + 100, pr, head })

function task(db: DatabaseSync, key: string): { state: string, lease_gen: number, failures: number } {
  return db.prepare('SELECT state, lease_gen, failures FROM tasks WHERE task_key = ?').get(key) as { state: string, lease_gen: number, failures: number }
}

function events(db: DatabaseSync, type: string): Record<string, unknown>[] {
  return db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type).map(row => JSON.parse(String(row.payload)) as Record<string, unknown>)
}

function eventCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n)
}

function expectReplayIdentical(db: DatabaseSync): void {
  const live = projectionDump(db)
  reduce(db)
  expect(projectionDump(db)).toBe(live)
}

describe('review worker', () => {
  it('a pass is recorded as a success review status on the leased head', async () => {
    const { db, gitHub, statuses, tick, worker } = setUp()
    gitHub.open({ number: 939 })
    tick()

    expect(await worker(reviewing()).step()).toEqual({ kind: 'recorded', taskKey: review(939), verdict: 'pass' })
    expect(statuses.map(status => status.state)).toEqual(['success'])
    expect(events(db, 'review.recorded')).toEqual([{ head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }])
    expectReplayIdentical(db)
    db.close()
  })

  it('a changes verdict is recorded as a review status on the leased head and as review.recorded', async () => {
    const { db, gitHub, statuses, tick, worker } = setUp()
    gitHub.open({ number: 940 })
    tick()

    expect(await worker(reviewing('reviewer-1', 'changes')).step()).toEqual({ kind: 'recorded', taskKey: review(940), verdict: 'changes' })
    expect(statuses).toEqual([{ commit: sha('a'), state: 'failure', context: 'review', description: 'review verdict changes for card #1040 by reviewer-1' }])
    expect(events(db, 'review.recorded')).toEqual([{ head: sha('a'), verdict: 'changes', reviewer_session: 'reviewer-1', findings: ['a finding'] }])
    expect(task(db, review(940))).toEqual({ state: 'completed', lease_gen: 1, failures: 0 })

    tick()
    expect(await worker(reviewing()).step()).toEqual({ kind: 'idle' })
    expectReplayIdentical(db)
    db.close()
  })

  it('a lease with a stale lease_gen cannot complete', () => {
    const { db, gitHub, clock, tick } = setUp()
    gitHub.open({ number: 941 })
    tick()
    const old = leaseNext(db, clock.now().toISOString(), 'review', 'worker:review:old')!
    clock.advance(LEASE_MS + 1)
    expect(expireLeases(db, clock.now().toISOString())).toEqual([review(941)])
    const current = leaseNext(db, clock.now().toISOString(), 'review', 'worker:review:new')!
    expect([old.leaseGen, current.leaseGen]).toEqual([1, 2])

    const before = eventCount(db)
    const ts = clock.now().toISOString()
    expect(() => completeTask(db, ts, old, [])).toThrow(StaleLease)
    expect(() => renewLease(db, ts, old)).toThrow(StaleLease)
    expect(() => failTask(db, ts, old, { reason: 'stale_head', withdraw: false })).toThrow(StaleLease)
    expect(eventCount(db)).toBe(before)
    expect(task(db, review(941))).toEqual({ state: 'leased', lease_gen: 2, failures: 1 })

    completeTask(db, ts, current, [])
    expect(task(db, review(941)).state).toBe('completed')
    expectReplayIdentical(db)
    db.close()
  })

  it('a verdict is not recorded when the head moved since the lease', async () => {
    const { db, gitHub, statuses, tick, worker } = setUp()
    gitHub.open({ number: 942 })
    tick()
    const moving: Reviewer = async () => {
      gitHub.open({ number: 942, head: sha('b') })
      return { verdict: 'pass', findings: [], session: 'reviewer-1' }
    }

    const step = await worker(moving).step()
    expect(step).toMatchObject({ kind: 'denied', taskKey: review(942), denial: { kind: 'technical', reason: 'stale_head' }, next: 'queued' })
    expect(statuses).toEqual([])
    expect(events(db, 'review.recorded')).toEqual([])

    tick()
    expect(task(db, review(942)).state).toBe('superseded')
    expect(task(db, review(942, sha('b'))).state).toBe('queued')
    expectReplayIdentical(db)
    db.close()
  })

  it('the reviewer session may not be the author session', async () => {
    const { db, gitHub, clock, statuses, tick, worker } = setUp()
    gitHub.open({ number: 943 })
    tick()
    appendEvent(db, { ts: clock.now().toISOString(), type: 'card.started', actor: 'worker:launch:author-1', cardId: 1043, pr: null, head: null, dedupeKey: 'card.started:1043', payload: { session: 'author-1' }, legacy: false })
    importJournal(db, JSON.stringify({ event: 'path', task: '1043', card: { id: 1043 }, sessions: [{ id: 'author-2' }] }))
    expect(authorSessions(db, 1043)).toEqual(new Set(['author-1', 'author-2']))

    const step = await worker(reviewing('author-2')).step()
    expect(step).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'reviewer_is_author' }, next: 'withdrawn' })
    expect(statuses).toEqual([])
    expect(task(db, review(943)).state).toBe('withdrawn')
    expect(ownerInbox(db)).toHaveLength(1)
    expect(await worker(reviewing('reviewer-1')).step()).toEqual({ kind: 'idle' })
    db.close()
  })

  it('a technical denial requeues the task and writes nothing to the owner inbox', async () => {
    const { db, gitHub, tick, worker } = setUp()
    gitHub.open({ number: 944 })
    tick()

    expect(await worker(reviewing(), unreachable).step()).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'github_error' }, next: 'queued' })
    expect(task(db, review(944))).toEqual({ state: 'queued', lease_gen: 1, failures: 1 })
    expect(events(db, 'policy.denied')).toMatchObject([{ command: 'record_verdict', kind: 'technical', reason: 'github_error' }])

    const unready: Reviewer = async () => {
      gitHub.pulls.get(944)!.required = 'pending'
      return { verdict: 'pass', findings: [], session: 'reviewer-1' }
    }
    expect(await worker(unready).step()).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'ci_not_ready' }, next: 'queued' })
    expect(ownerInbox(db)).toEqual([])
    expectReplayIdentical(db)
    db.close()
  })

  it('three failures in a row stop the card with fault and raise a board alarm', async () => {
    const { db, gitHub, tick, worker } = setUp()
    gitHub.open({ number: 945 })
    tick()
    const failing = worker(reviewing(), unreachable)

    for (const next of ['queued', 'queued', 'stopped'])
      expect(await failing.step()).toMatchObject({ kind: 'denied', next })
    expect(task(db, review(945))).toEqual({ state: 'stopped', lease_gen: 3, failures: 3 })
    expect(events(db, 'card.stopped')).toEqual([{ reason: 'fault', detail: `3 failures in a row on ${review(945)}, the last: github_error` }])
    expect(events(db, 'board.alarm')).toMatchObject([{ task_key: review(945), reason: 'fault', failures: 3 }])
    expect(ownerInbox(db)).toEqual([])
    expect(await failing.step()).toEqual({ kind: 'idle' })
    tick()
    expect(await failing.step()).toEqual({ kind: 'idle' })
    expectReplayIdentical(db)
    db.close()
  })

  it('a heartbeat renews the lease while the review runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { db, gitHub, clock, tick, worker } = setUp()
    gitHub.open({ number: 946 })
    tick()
    let finish: () => void = () => {}
    const slow: Reviewer = async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { verdict: 'pass', findings: [], session: 'reviewer-1' }
    }

    const step = worker(slow).step()
    for (let beat = 0; beat < 2; beat += 1) {
      clock.advance(RENEW_MS)
      await vi.advanceTimersByTimeAsync(RENEW_MS)
    }
    expect(events(db, 'task.renewed')).toHaveLength(2)
    expect((db.prepare('SELECT lease_until FROM tasks').get() as { lease_until: string }).lease_until).toBe(new Date(clock.ms + LEASE_MS).toISOString())
    finish()
    expect(await step).toMatchObject({ kind: 'recorded' })
    expectReplayIdentical(db)
    db.close()
  })

  it('the worker refuses to start while the shadow report is not clean', () => {
    const { db, gitHub, clock, tick } = setUp()
    const parts = { db, gitHub: gitHub.client, publish: unreachable, reviewer: reviewing(), clock: clock.now, session: 'worker-1' }
    gitHub.open({ number: 947 })
    tick()
    gitHub.open({ number: 947, head: sha('c') })

    expect(() => startReviewWorker(parts)).toThrow(ShadowNotClean)
    try {
      startReviewWorker(parts)
    }
    catch (error) {
      expect((error as ShadowNotClean).problems).toEqual([`prs vs GitHub: #947 at ${sha('a')} here, ${sha('c')} on GitHub`])
    }

    gitHub.open({ number: 948 })
    expect(() => startReviewWorker(parts)).toThrow(/#948 open on GitHub, missing here/)

    tick()
    expect(startReviewWorker(parts)).toBeInstanceOf(ReviewWorker)

    db.prepare(`INSERT INTO events (ts, type, actor, pr, head, dedupe_key, payload) VALUES (?, 'pr.observed', 'netwatch', 947, ?, 'pr:947:unreduced', ?)`)
      .run(clock.now().toISOString(), sha('d'), JSON.stringify({ base: 'main', head: sha('d'), mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }))
    expect(() => startReviewWorker(parts)).toThrow(/replay byte-diff: differs/)
    db.close()
  })

  it('a dry run prints the review and writes nothing to the bus or GitHub', async () => {
    const { db, gitHub, statuses, tick } = setUp()
    gitHub.open({ number: 949 })
    tick()
    gitHub.open({ number: 949, head: sha('e') })
    const before = { events: eventCount(db), tasks: projectionDump(db) }
    gitHub.calls.length = 0
    const leases: Lease[] = []
    const reviewer: Reviewer = async (lease) => {
      leases.push(lease)
      return { verdict: 'changes', findings: ['the first finding', 'the second finding'], session: 'reviewer-dry' }
    }

    const lines = await dryRun(gitHub.client, reviewer, 949)
    expect(leases).toEqual([{ taskKey: review(949, sha('e')), queue: 'review', cardId: 1049, pr: 949, head: sha('e'), leaseGen: 0, actor: DRY_RUN_ACTOR }])
    expect(lines.join('\n')).toContain(sha('e'))
    expect(lines.join('\n')).toContain('verdict: changes')
    expect(lines.join('\n')).toContain('reviewer session: reviewer-dry')
    expect(lines.filter(line => line.includes('finding: '))).toHaveLength(2)
    expect(gitHub.calls).toEqual(['repos/{owner}/{repo}/pulls/949'])
    expect(statuses).toEqual([])
    expect(gitHub.pulls.get(949)!.review).toBeUndefined()
    expect({ events: eventCount(db), tasks: projectionDump(db) }).toEqual(before)
    expect(reviewMode(['--dry-run', '949'])).toEqual({ kind: 'dry-run', pr: 949 })
    db.close()
  })

  it('a dry run together with the switch is refused', () => {
    for (const argv of [['--dry-run', '949', '--on'], ['--on', '--dry-run', '949']])
      expect(reviewMode(argv)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('not both') })
    expect(reviewMode(['--dry-run'])).toMatchObject({ kind: 'refused' })
    expect(reviewMode(['--on'])).toEqual({ kind: 'on' })
    expect(reviewMode([])).toEqual({ kind: 'off' })
  })
})

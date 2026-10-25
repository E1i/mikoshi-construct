import type { Lease } from '../../core/lease.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { recordHeartbeat } from '../../supervisor/heartbeat.js'
import { taskKey } from '../../core/identifiers.js'
import { completeTask, expireLeases, failTask, LEASE_MS, leaseNext, leaseQueued, RENEW_MS, StaleLease } from '../../core/lease.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { RateLimited } from '../../ports/meter.js'
import { FAILURES_TO_STOP, queueTask } from '../../core/queue.js'
import { BOARD_ALARM, CARD_STOPPED, POLICY_DENIED, TASK_COMPLETED, TASK_ENQUEUED, TASK_FAILED, TASK_LEASED } from '../../core/events.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'
import { detectMerge } from './merge-detection.js'
import { detectReview } from './review-detection.js'

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
})

function tasksIn(made: MergeBench, queue: string): number {
  return Number((made.db.prepare('SELECT count(*) AS n FROM tasks WHERE queue = ?').get(queue) as { n: number }).n)
}

function enqueuedIn(made: MergeBench, queue: string): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.queue') = ?`).get(TASK_ENQUEUED, queue) as { n: number }).n)
}

describe('the derived queues', () => {
  it('deriveQueues sets no review and no merge task; only the live review and merge nodes do', () => {
    const made = mergeBench()
    benches.push(made)
    made.gitHub.open({ number: 980 })
    made.gitHub.open({ number: 981, head: sha('b'), review: 'success' })
    made.gitHub.statuses.set(sha('b'), 'success')
    made.tick()
    made.tick()
    expect({ review: tasksIn(made, 'review'), merge: tasksIn(made, 'merge') }).toEqual({ review: 0, merge: 0 })
    expect({ review: enqueuedIn(made, 'review'), merge: enqueuedIn(made, 'merge') }).toEqual({ review: 0, merge: 0 })

    detectReview(made)
    detectMerge(made)
    expect({ review: tasksIn(made, 'review'), merge: tasksIn(made, 'merge') }).toEqual({ review: 1, merge: 1 })

    made.tick()
    detectReview(made)
    detectMerge(made)
    expect({ review: enqueuedIn(made, 'review'), merge: enqueuedIn(made, 'merge') }).toEqual({ review: 1, merge: 1 })
  })
})

const PR = 970
const CARD = PR + 100
const HEAD = sha('a')

function now(made: MergeBench): string {
  return made.clock.now().toISOString()
}

function queuedAnswer(made: MergeBench): string {
  made.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
  made.tick()
  const task = { queue: 'answer' as const, cardId: CARD, pr: PR, head: HEAD }
  queueTask(made.db, now(made), task)
  return taskKey(task)
}

function beat(made: MergeBench, lease: Lease): void {
  recordHeartbeat(made.db, now(made), { card: CARD, pr: PR, head: HEAD, step: 'answer', session: 'session-1', lease: { taskKey: lease.taskKey, leaseGen: lease.leaseGen } })
}

function cardBeat(made: MergeBench): void {
  recordHeartbeat(made.db, now(made), { card: CARD, pr: PR, head: HEAD, step: 'launch', session: 'session-1', lease: null })
}

function failUntilTheLast(made: MergeBench): void {
  for (let failure = 1; failure < FAILURES_TO_STOP; failure += 1)
    failTask(made.db, now(made), leaseNext(made.db, now(made), 'answer', 'worker:answer:a')!, { reason: 'answer_failed', withdraw: false })
}

function ofTask(made: MergeBench, type: string, key: string): number {
  return eventsOf(made.db, type).filter(payload => payload.task_key === key).length
}

describe('one lease contract', () => {
  it('two leases of one task: only one is granted', () => {
    const made = mergeBench()
    benches.push(made)
    const key = queuedAnswer(made)

    expect(leaseNext(made.db, now(made), 'answer', 'worker:answer:a')).toMatchObject({ taskKey: key, leaseGen: 1 })
    expect(leaseNext(made.db, now(made), 'answer', 'worker:answer:b')).toBeNull()
    expect(leaseQueued(made.db, now(made), key, 'worker:answer:b')).toBeNull()
    expect(ofTask(made, TASK_LEASED, key)).toBe(1)
  })

  it('a killed worker: the task is taken exactly once and completed once', () => {
    const made = mergeBench()
    benches.push(made)
    const key = queuedAnswer(made)
    failUntilTheLast(made)
    const killed = leaseNext(made.db, now(made), 'answer', 'worker:answer:killed')!
    const taken: Lease[] = []
    const take = (): void => {
      expireLeases(made.db, now(made))
      const lease = leaseNext(made.db, now(made), 'answer', 'worker:answer:next')
      if (lease !== null)
        taken.push(lease)
    }
    made.clock.advance(LEASE_MS - RENEW_MS)
    cardBeat(made)
    made.clock.advance(RENEW_MS + 1_000)
    take()
    expect(taken).toEqual([])

    made.clock.advance(SILENT_MS)
    take()
    take()
    expect(taken).toHaveLength(1)
    completeTask(made.db, now(made), taken[0]!, [])
    expect(() => completeTask(made.db, now(made), killed, [])).toThrow(StaleLease)
    expect(ofTask(made, TASK_COMPLETED, key)).toBe(1)
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(taskState(made.db, key).state).toBe('completed')
  })

  it('fault is not written while the task heartbeat is fresh', () => {
    const made = mergeBench()
    benches.push(made)
    const key = queuedAnswer(made)
    failUntilTheLast(made)
    const last = leaseNext(made.db, now(made), 'answer', 'worker:answer:a')!
    beat(made, last)

    expect(failTask(made.db, now(made), last, { reason: 'answer_failed', withdraw: false })).toBe('queued')
    expect({ stopped: eventsOf(made.db, CARD_STOPPED), alarms: eventsOf(made.db, BOARD_ALARM), failed: ofTask(made, TASK_FAILED, key) }).toEqual({ stopped: [], alarms: [], failed: FAILURES_TO_STOP - 1 })
    expect(taskState(made.db, key)).toMatchObject({ state: 'queued', failures: FAILURES_TO_STOP - 1 })
    expect(leaseNext(made.db, now(made), 'answer', 'worker:answer:a')).toBeNull()

    made.clock.advance(SILENT_MS + 1_000)
    const silent = leaseNext(made.db, now(made), 'answer', 'worker:answer:a')!
    expect(failTask(made.db, now(made), silent, { reason: 'answer_failed', withdraw: false })).toBe('stopped')
    expect(eventsOf(made.db, CARD_STOPPED)).toHaveLength(1)
  })

  it('a card session beat with no task key defers no fault of a task whose queue runs no card session', () => {
    const made = mergeBench()
    benches.push(made)
    made.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
    made.tick()
    const task = { queue: 'merge' as const, cardId: CARD, pr: PR, head: HEAD }
    queueTask(made.db, now(made), task)
    for (let failure = 1; failure < FAILURES_TO_STOP; failure += 1)
      failTask(made.db, now(made), leaseNext(made.db, now(made), 'merge', 'worker:merge:a')!, { reason: 'github_error', withdraw: false })
    const last = leaseNext(made.db, now(made), 'merge', 'worker:merge:a')!
    cardBeat(made)

    expect(failTask(made.db, now(made), last, { reason: 'github_error', withdraw: false })).toBe('stopped')
    expect(eventsOf(made.db, CARD_STOPPED)).toHaveLength(1)
  })

  it('a 403 with retry-after that an executor caught ends the task as wait and counts no failure', () => {
    const made = mergeBench()
    benches.push(made)
    const key = queuedAnswer(made)
    const lease = leaseNext(made.db, now(made), 'answer', 'worker:answer:a')!
    const limited = new RateLimited(403, 120)
    const denied = { ts: now(made), type: POLICY_DENIED, actor: 'policy', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `${POLICY_DENIED}:${key}:1`, payload: { kind: 'technical', reason: 'github_error', detail: limited.message }, legacy: false }

    expect(failTask(made.db, now(made), lease, { reason: 'github_error', withdraw: false }, [denied])).toBe('queued')
    expect(ofTask(made, TASK_FAILED, key)).toBe(0)
    expect(taskState(made.db, key)).toMatchObject({ state: 'queued', failures: 0 })
    expect(leaseNext(made.db, now(made), 'answer', 'worker:answer:a')).toBeNull()
    made.clock.advance(120_000)
    expect(leaseNext(made.db, now(made), 'answer', 'worker:answer:a')).toMatchObject({ taskKey: key })
  })

  it('a 403 with retry-after that the merge executor meets ends the merge task as wait and counts no failure', () => {
    const made = mergeBench()
    benches.push(made)
    made.gitHub.open({ number: 981, head: sha('b'), review: 'success' })
    made.gitHub.statuses.set(sha('b'), 'success')
    made.tick()
    made.tick()
    detectMerge(made)
    const lease = made.lease()!
    made.gitHub.limited = { status: 403, headers: { 'retry-after': '120' }, body: { message: 'API rate limit exceeded' } }

    expect(made.merge(lease)).toMatchObject({ kind: 'denied', next: 'queued' })
    expect(ofTask(made, TASK_FAILED, lease.taskKey)).toBe(0)
    expect(taskState(made.db, lease.taskKey)).toMatchObject({ state: 'queued', failures: 0 })
    expect(made.lease()).toBeNull()

    made.gitHub.limited = null
    made.clock.advance(120_000)
    expect(made.lease()).toMatchObject({ taskKey: lease.taskKey })
  })
})

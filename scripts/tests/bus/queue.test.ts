import type { Lease } from '../../bus/lease.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { recordHeartbeat } from '../../bus/heartbeat.js'
import { taskKey } from '../../bus/identifiers.js'
import { completeTask, expireLeases, failTask, LEASE_MS, leaseNext, leaseQueued, RENEW_MS, StaleLease } from '../../bus/lease.js'
import { SILENT_MS } from '../../bus/liveness-sites.js'
import { FAILURES_TO_STOP, queueTask } from '../../bus/queue.js'
import { BOARD_ALARM, CARD_STOPPED, TASK_COMPLETED, TASK_ENQUEUED, TASK_FAILED, TASK_LEASED } from '../../core/events.js'
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
    const killed = leaseNext(made.db, now(made), 'answer', 'worker:answer:killed')!
    const taken: Lease[] = []
    const take = (): void => {
      expireLeases(made.db, now(made))
      const lease = leaseNext(made.db, now(made), 'answer', 'worker:answer:next')
      if (lease !== null)
        taken.push(lease)
    }
    for (let beats = 0; beats * RENEW_MS <= 2 * LEASE_MS; beats += 1) {
      beat(made, killed)
      made.clock.advance(RENEW_MS)
      take()
    }
    expect(taken).toEqual([])

    made.clock.advance(LEASE_MS)
    take()
    take()
    expect(taken).toHaveLength(1)
    completeTask(made.db, now(made), taken[0]!, [])
    expect(() => completeTask(made.db, now(made), killed, [])).toThrow(StaleLease)
    expect(ofTask(made, TASK_COMPLETED, key)).toBe(1)
    expect(taskState(made.db, key).state).toBe('completed')
  })

  it('fault is not written while the task heartbeat is fresh', () => {
    const made = mergeBench()
    benches.push(made)
    const key = queuedAnswer(made)
    for (let failure = 1; failure < FAILURES_TO_STOP; failure += 1)
      failTask(made.db, now(made), leaseNext(made.db, now(made), 'answer', 'worker:answer:a')!, { reason: 'answer_failed', withdraw: false })
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
})

import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { TASK_ENQUEUED } from '../../bus/queue.js'
import { sha } from './github-fake.js'
import { mergeBench } from './merge-bench.js'
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

import type { DetectionMode, Scope } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import type { Reviewer } from '../../bus/reviewer.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prBodySha, taskKey } from '../../bus/identifiers.js'
import { NetWatch } from '../../bus/netwatch.js'
import { detectionMode } from '../../bus/node.js'
import { reduce } from '../../bus/reducer.js'
import { fullReview } from '../../bus/review-depth.js'
import { ReviewNode } from '../../bus/review-worker.js'
import { switchDetection, switchWorker, wantedLaunches } from '../../bus/workers.js'
import { NODE_DETECTED, REVIEW_RECORDED, TASK_ENQUEUED } from '../../core/events.js'
import { cardBody } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })

const benches: MergeBench[] = []
const NO_PREFLIGHT = (): string[] => []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
})

const passing: Reviewer = async lease => ({ verdict: 'pass', findings: [], session: `reviewer-${lease.pr}` })

class ProbedReviewNode extends ReviewNode {
  private calls = 0
  private failOnCall: number | null = null

  failOnNextCall(after: number): void {
    this.failOnCall = this.calls + after
  }

  protected override before(): void {}

  protected override candidates(scope?: Scope): QueuedTask[] {
    this.calls += 1
    if (this.calls === this.failOnCall)
      throw new Error('injected in the middle of a batch')
    return super.candidates(scope)
  }
}

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function nodeOf(made: MergeBench, mode: DetectionMode = 'live'): ProbedReviewNode {
  return new ProbedReviewNode({ db: made.db, gitHub: made.gitHub.client, publish: made.gitHub.publish, reviewer: passing, plan: () => fullReview('a fixed plan'), clock: made.clock.now, session: 'node-1', mode, env: {}, isolation: sandboxed })
}

async function once(node: ReviewNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function observedWithoutDeriveQueues(made: MergeBench): void {
  new NetWatch(made.db, made.gitHub.client, made.clock.now).poll()
  reduce(made.db)
}

function headOf(pr: number): string {
  return pr.toString(16).padStart(40, '0')
}

function openGreen(made: MergeBench, pr: number): void {
  made.gitHub.open({ number: pr, head: headOf(pr) })
}

function reviewKey(pr: number): string {
  return taskKey({ queue: 'review', cardId: pr + 100, pr, head: headOf(pr), input: { prBody: prBodySha(cardBody(pr)), cardBody: null } })
}

function count(made: MergeBench, sql: string, ...args: (string | number)[]): number {
  return Number((made.db.prepare(sql).get(...args) as { n: number }).n)
}

function reviewTasks(made: MergeBench, pr: number): number {
  return count(made, `SELECT count(*) AS n FROM tasks WHERE queue = 'review' AND pr = ?`, pr)
}

function enqueuedOf(made: MergeBench, pr: number): number {
  return count(made, `SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.task_key') = ?`, TASK_ENQUEUED, reviewKey(pr))
}

function reviewsOf(made: MergeBench, pr: number): number {
  return count(made, `SELECT count(*) AS n FROM events WHERE type = ? AND pr = ?`, REVIEW_RECORDED, pr)
}

function detectedOf(made: MergeBench, pr: number): Record<string, unknown>[] {
  return eventsOf(made.db, NODE_DETECTED).filter(payload => payload.key === reviewKey(pr))
}

type Order = 'node first' | 'deriveQueues first' | 'same tick'

const ORDERS: Order[] = ['node first', 'deriveQueues first', 'same tick']

describe('review live', () => {
  it('a live review node and deriveQueues on one db leave exactly one tasks row, one task.enqueued and one review.recorded, with node.detected queued whichever ticks first', async () => {
    for (const order of ORDERS) {
      const made = bench()
      openGreen(made, 980)
      const node = nodeOf(made)
      if (order === 'node first') {
        observedWithoutDeriveQueues(made)
        await once(node)
        made.tick()
      }
      else if (order === 'deriveQueues first') {
        made.tick()
        await once(node)
      }
      else {
        observedWithoutDeriveQueues(made)
        const pass = once(node)
        made.tick()
        await pass
      }
      await once(node)
      made.tick()
      await once(node)

      expect(reviewTasks(made, 980), order).toBe(1)
      expect(enqueuedOf(made, 980), order).toBe(1)
      expect(reviewsOf(made, 980), order).toBe(1)
      const detected = detectedOf(made, 980)
      expect(detected, order).toHaveLength(1)
      expect(detected[0]!.outcome, order).toBe('queued')
    }
  })

  it('a live review node restarted mid-batch writes no second task, no second review.recorded and one node.detected, queued by the restarted node', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)

    for (const pr of [981, 982])
      openGreen(made, pr)
    observedWithoutDeriveQueues(made)
    node.failOnNextCall(1)
    await expect(once(node)).rejects.toThrow('injected in the middle of a batch')
    for (const pr of [981, 982]) {
      expect(detectedOf(made, pr)).toEqual([])
      expect(reviewTasks(made, pr)).toBe(0)
    }

    made.tick()
    const restarted = nodeOf(made)
    await once(restarted)
    made.tick()
    await once(nodeOf(made))
    made.tick()
    await once(restarted)

    for (const pr of [981, 982]) {
      expect(reviewTasks(made, pr)).toBe(1)
      expect(enqueuedOf(made, pr)).toBe(1)
      expect(reviewsOf(made, pr)).toBe(1)
      expect(detectedOf(made, pr).map(payload => payload.outcome)).toEqual(['queued'])
    }
  })

  it('after review is switched from live back to shadow neither the node nor deriveQueues enqueues a review', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-review-switch-'))
    try {
      switchWorker(root, 'review', true)
      const reviewMode = (): DetectionMode => detectionMode(wantedLaunches(root, NO_PREFLIGHT).find(launch => launch.script === 'bus:review')!.args)
      expect(switchDetection(root, 'review', true)).toEqual(['review'])
      expect(reviewMode()).toBe('live')

      const made = bench()
      openGreen(made, 980)
      observedWithoutDeriveQueues(made)
      await once(nodeOf(made, reviewMode()))
      expect(detectedOf(made, 980).map(payload => payload.outcome)).toEqual(['queued'])

      expect(switchDetection(root, 'review', false)).toEqual([])
      expect(reviewMode()).toBe('shadow')
      const shadow = nodeOf(made, reviewMode())
      openGreen(made, 981)
      observedWithoutDeriveQueues(made)
      await once(shadow)
      expect(detectedOf(made, 981).map(payload => payload.via).sort()).toEqual(['event', 'tick'])
      expect(detectedOf(made, 981).filter(payload => 'outcome' in payload)).toEqual([])
      expect(reviewTasks(made, 981)).toBe(0)
      expect(enqueuedOf(made, 981)).toBe(0)

      made.tick()
      await once(shadow)
      expect(reviewTasks(made, 981)).toBe(0)
      expect(enqueuedOf(made, 981)).toBe(0)
      expect(reviewsOf(made, 981)).toBe(0)
      expect(reviewTasks(made, 980)).toBe(1)
      expect(enqueuedOf(made, 980)).toBe(1)
      expect(reviewsOf(made, 980)).toBe(1)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

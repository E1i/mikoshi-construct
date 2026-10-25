import type { DetectionMode, Scope } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { NODE_DETECTED, REVIEW_RECORDED, TASK_ENQUEUED } from '../../core/events.js'
import { detectionMode } from '../../core/node.js'
import { keyOf } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { UpdateNode } from '../../nodes/update/update-worker.js'
import { NetWatch } from '../../ports/netwatch.js'
import { switchDetection, switchWorker, wantedLaunches } from '../../supervisor/workers.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

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

class ProbedUpdateNode extends UpdateNode {
  private calls = 0
  private failOnCall: number | null = null

  failOnNextCall(after: number): void {
    this.failOnCall = this.calls + after
  }

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
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
  return made
}

function nodeOf(made: MergeBench, mode: DetectionMode = 'live'): ProbedUpdateNode {
  return new ProbedUpdateNode({ db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, settle: () => {}, session: 'node-1', mode, env: {} })
}

async function once(node: UpdateNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function observedWithoutDeriveQueues(made: MergeBench): void {
  new NetWatch(made.db, made.gitHub.client, made.clock.now).poll()
  reduce(made.db)
}

function updateKey(pr: number): string {
  return keyOf({ queue: 'update', cardId: pr + 100, pr, head: sha('a') })
}

function count(made: MergeBench, sql: string, ...args: (string | number)[]): number {
  return Number((made.db.prepare(sql).get(...args) as { n: number }).n)
}

function updateTasks(made: MergeBench, pr: number): number {
  return count(made, `SELECT count(*) AS n FROM tasks WHERE queue = 'update' AND pr = ?`, pr)
}

function enqueuedOf(made: MergeBench, pr: number): number {
  return count(made, `SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.task_key') = ?`, TASK_ENQUEUED, updateKey(pr))
}

function detectedOf(made: MergeBench, pr: number): Record<string, unknown>[] {
  return eventsOf(made.db, NODE_DETECTED).filter(payload => payload.key === updateKey(pr))
}

const ORDERS = ['node first', 'deriveQueues first', 'same tick'] as const

describe('update live', () => {
  it('a live update node and deriveQueues on one db leave exactly one tasks row, one task.enqueued and one node.detected with outcome queued, in every order', async () => {
    for (const order of ORDERS) {
      const made = bench()
      made.gitHub.open({ number: 980, review: 'success', mergeable_state: 'behind' })
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

      expect(updateTasks(made, 980), order).toBe(1)
      expect(enqueuedOf(made, 980), order).toBe(1)
      const detected = detectedOf(made, 980)
      expect(detected, order).toHaveLength(1)
      expect(detected[0]!.outcome, order).toBe('queued')
    }
  })

  it('deriveQueues alone enqueues no update task', async () => {
    const made = bench()
    made.gitHub.open({ number: 980, review: 'success', mergeable_state: 'behind' })
    made.tick()
    made.tick()
    expect(updateTasks(made, 980)).toBe(0)
    expect(enqueuedOf(made, 980)).toBe(0)
    expect(count(made, `SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.queue') = 'update'`, TASK_ENQUEUED)).toBe(0)

    const node = nodeOf(made)
    await once(node)
    expect(updateTasks(made, 980)).toBe(1)
    expect(enqueuedOf(made, 980)).toBe(1)

    await once(node)
    expect(updateTasks(made, 980)).toBe(1)
    expect(enqueuedOf(made, 980)).toBe(1)
  })

  it('a live update node restarted mid-batch writes no second task and no second node.detected', async () => {
    const made = bench()
    for (const pr of [981, 982])
      made.gitHub.open({ number: pr, review: 'success' })
    made.tick()
    const node = nodeOf(made)
    await once(node)
    for (const pr of [981, 982])
      made.gitHub.pulls.get(pr)!.mergeable_state = 'behind'
    made.tick()
    node.failOnNextCall(1)
    await expect(once(node)).rejects.toThrow('injected in the middle of a batch')
    for (const pr of [981, 982]) {
      expect(detectedOf(made, pr)).toEqual([])
      expect(updateTasks(made, pr)).toBe(0)
    }

    made.tick()
    const restarted = nodeOf(made)
    await once(restarted)
    made.tick()
    await once(nodeOf(made))
    made.tick()
    await once(restarted)

    for (const pr of [981, 982]) {
      expect(updateTasks(made, pr)).toBe(1)
      expect(enqueuedOf(made, pr)).toBe(1)
      expect(detectedOf(made, pr).map(payload => payload.outcome)).toEqual(['queued'])
    }
  })

  it('after update is switched from live back to shadow neither the node nor deriveQueues enqueues an update task', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-update-switch-'))
    try {
      switchWorker(root, 'update', true)
      const updateMode = (): DetectionMode => detectionMode(wantedLaunches(root, NO_PREFLIGHT).find(launch => launch.script === 'bus:update')!.args)
      expect(switchDetection(root, 'update', true)).toEqual(['update'])
      expect(updateMode()).toBe('live')

      const made = bench()
      made.gitHub.open({ number: 980, review: 'success', mergeable_state: 'behind' })
      observedWithoutDeriveQueues(made)
      await once(nodeOf(made, updateMode()))
      expect(detectedOf(made, 980).map(payload => payload.outcome)).toEqual(['queued'])

      expect(switchDetection(root, 'update', false)).toEqual([])
      expect(updateMode()).toBe('shadow')
      const shadow = nodeOf(made, updateMode())
      made.gitHub.open({ number: 981, review: 'success', mergeable_state: 'behind' })
      observedWithoutDeriveQueues(made)
      await once(shadow)
      expect(detectedOf(made, 981).map(payload => payload.via).sort()).toEqual(['event', 'tick'])
      expect(detectedOf(made, 981).filter(payload => 'outcome' in payload)).toEqual([])
      expect(updateTasks(made, 981)).toBe(0)
      expect(enqueuedOf(made, 981)).toBe(0)

      made.tick()
      await once(shadow)
      expect(updateTasks(made, 981)).toBe(0)
      expect(enqueuedOf(made, 981)).toBe(0)
      expect(updateTasks(made, 980)).toBe(1)
      expect(enqueuedOf(made, 980)).toBe(1)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

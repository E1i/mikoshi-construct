import type { MergeNodeParts } from '../../bus/merge-worker.js'
import type { DetectionMode, Scope } from '../../bus/node.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MERGE_DONE, REVIEW_RECORDED } from '../../bus/card-automaton.js'
import { appendEvent } from '../../bus/db.js'
import { recordDecision } from '../../bus/decisions.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { completeTask, leaseNext } from '../../bus/lease.js'
import { MergeNode } from '../../bus/merge-worker.js'
import { NODE_CURSORS, NODE_DETECTED, NODE_EQUIVALENCE } from '../../bus/node.js'
import { keyOf, MERGE_CANDIDATES, mergeCandidates, queueTask, TASK_ENQUEUED } from '../../bus/queue.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, mergeBench, spendReviewRounds } from './merge-bench.js'

const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const bench of benches.splice(0))
    bench.close()
})

class ProbedMergeNode extends MergeNode {
  found(scope?: Scope): string[] {
    return this.candidates(scope).map(keyOf)
  }
}

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
  return made
}

function nodeOf(made: MergeBench, mode: DetectionMode = 'shadow'): ProbedMergeNode {
  const parts: MergeNodeParts = { db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, session: 'node-1', run: null, mode, env: {} }
  return new ProbedMergeNode(parts)
}

async function once(node: MergeNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function mergeKey(pr: number, head = sha('a')): string {
  return keyOf({ queue: 'merge', cardId: pr + 100, pr, head })
}

function derivedKeys(made: MergeBench): string[] {
  return mergeCandidates(made.db, made.clock.now().toISOString()).map(keyOf)
}

function dependsOn(made: MergeBench, cardId: number, dependency: number): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'reducer', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [dependency] }, legacy: false })
}

function mergeDone(made: MergeBench, cardId: number, pr: number): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: MERGE_DONE, actor: 'worker:merge:worker-0', cardId, pr, head: sha('e'), dedupeKey: `${MERGE_DONE}:${pr}`, payload: { commit: sha('f'), rule: 'auto' }, legacy: false })
  return Number((made.db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
}

function mergeTasks(made: MergeBench, pr: number): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'merge' AND pr = ?`).get(pr) as { n: number }).n)
}

function enqueuedOf(made: MergeBench, key: string): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.task_key') = ?`).get(TASK_ENQUEUED, key) as { n: number }).n)
}

function equivalences(made: MergeBench): Record<string, unknown>[] {
  return eventsOf(made.db, NODE_EQUIVALENCE)
}

describe('mergeCandidates', () => {
  it('leaves out a pull request with a pass that is out of review rounds and has no owner decision, and deriveQueues queues none for it', () => {
    const made = bench()
    made.gitHub.open({ number: 970, head: sha('a'), review: 'success' })
    spendReviewRounds(made, 970, sha('a'))
    made.tick()

    expect(made.db.prepare(MERGE_CANDIDATES).all().map(row => row.pr)).toEqual([970])
    expect(derivedKeys(made)).toEqual([])
    expect(mergeTasks(made, 970)).toBe(0)
  })
})

describe('the merge node', () => {
  it('finds through candidates() what mergeCandidates finds: a green pass on a clean head, scoped by pull request and card', () => {
    const made = bench()
    made.gitHub.open({ number: 970, review: 'success' })
    made.gitHub.open({ number: 971, review: 'success' })
    made.tick()
    const node = nodeOf(made)

    expect(node.found()).toEqual([mergeKey(970), mergeKey(971)])
    expect(node.found()).toEqual(derivedKeys(made))
    expect(node.found({ pr: 971 })).toEqual([mergeKey(971)])
    expect(node.found({ cardId: 1070 })).toEqual([mergeKey(970)])
    expect(node.found({ pr: 970, cardId: 1071 })).toEqual([])
  })

  it('finds no pull request past the round limit without a decision, and finds it once the owner decision names its head', () => {
    const made = bench()
    made.gitHub.open({ number: 970, head: sha('a'), review: 'failure' })
    spendReviewRounds(made, 970, sha('a'))
    made.tick()
    const node = nodeOf(made)
    expect(node.found()).toEqual([])

    recordDecision(made.db, { ts: made.clock.now().toISOString(), decisionId: 120, text: `allow-merge PR #970 at ${sha('a')} past the round limit`, cards: [] })
    made.tick()
    expect(node.found()).toEqual([mergeKey(970)])
    expect(node.found()).toEqual(derivedKeys(made))
  })

  it('a merge.done of a dependency is detected by event for the dependent pull request, which no scope by that event would name', async () => {
    const made = bench()
    dependsOn(made, 826, 838)
    made.gitHub.open({ number: 726, review: 'success', body: cardBody(726, 'auto') })
    made.tick()
    const node = nodeOf(made)
    await once(node)
    expect(node.found()).toEqual([])

    const done = mergeDone(made, 838, 738)
    await once(node)
    expect(eventsOf(made.db, NODE_DETECTED).filter(each => each.via === 'event')).toEqual([{ key: mergeKey(726), via: 'event', event_id: done }])
  })

  it('in shadow mode records node.detected and node.equivalence with nothing only on one side, and queues nothing itself', async () => {
    const made = bench()
    made.gitHub.open({ number: 970, review: 'success' })
    made.tick()
    const node = nodeOf(made)
    const tasks = mergeTasks(made, 970)
    const before = enqueuedOf(made, mergeKey(970))
    await once(node)

    expect(eventsOf(made.db, NODE_DETECTED)).toEqual([{ key: mergeKey(970), via: 'tick', event_id: expect.any(Number) as unknown }])
    expect(equivalences(made)).toEqual([{ same: [mergeKey(970)], only_node: [], only_derive: [], event_id: expect.any(Number) as unknown }])
    expect(enqueuedOf(made, mergeKey(970))).toBe(before)
    expect(mergeTasks(made, 970)).toBe(tasks)
  })

  it('i1: in live mode the node and deriveQueues detect one key, and there is one task row, one task.enqueued and one merge.done', async () => {
    const made = bench()
    dependsOn(made, 826, 838)
    made.gitHub.open({ number: 726, review: 'success', body: cardBody(726, 'auto') })
    made.tick()
    const node = nodeOf(made, 'live')
    await once(node)
    mergeDone(made, 838, 738)

    await once(node)
    expect(enqueuedOf(made, mergeKey(726))).toBe(1)
    made.tick()
    await once(node)

    expect(mergeTasks(made, 726)).toBe(1)
    expect(enqueuedOf(made, mergeKey(726))).toBe(1)
    expect(eventsOf(made.db, MERGE_DONE).filter(each => each.rule === 'auto' && each.commit !== sha('f'))).toHaveLength(1)
  })

  it('the live merge node detects no head with a review in flight, and detects it on the review.recorded that ends it', async () => {
    const made = bench()
    made.gitHub.open({ number: 970, review: 'success' })
    queueTask(made.db, made.clock.now().toISOString(), { queue: 'review', cardId: 1070, pr: 970, head: sha('a') })
    made.tick()
    const node = nodeOf(made, 'live')
    await once(node)
    expect(node.found()).toEqual([])
    expect(derivedKeys(made)).toEqual([])
    expect(mergeTasks(made, 970)).toBe(0)

    const ts = made.clock.now().toISOString()
    completeTask(made.db, ts, leaseNext(made.db, ts, 'review', 'worker:review:reviewer-1')!, [])
    appendEvent(made.db, { ts, type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:in-flight`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
    const recorded = Number((made.db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
    await once(node)

    expect(eventsOf(made.db, NODE_DETECTED).filter(each => each.key === mergeKey(970))).toEqual([expect.objectContaining({ key: mergeKey(970), via: 'event', event_id: recorded, outcome: 'queued' })])
    expect(mergeTasks(made, 970)).toBe(1)
  })

  it('i3: a cursor reset to 0 after the merge gives no second detection, no second task and no second merge.done', async () => {
    for (const mode of ['live'] as const) {
      const made = bench()
      made.gitHub.open({ number: 970, review: 'success' })
      made.tick()
      const node = nodeOf(made, mode)
      await once(node)
      await once(node)
      made.tick()
      const before = { detected: eventsOf(made.db, NODE_DETECTED).length, enqueued: enqueuedOf(made, mergeKey(970)), done: eventsOf(made.db, MERGE_DONE).length }
      expect(before.done, mode).toBe(1)

      made.db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = 0`).run()
      await once(node)
      made.tick()
      await once(node)
      expect({ detected: eventsOf(made.db, NODE_DETECTED).length, enqueued: enqueuedOf(made, mergeKey(970)), done: eventsOf(made.db, MERGE_DONE).length }, mode).toEqual(before)
    }
  })
})

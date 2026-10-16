import type { AnswerNodeParts, AnswerStep } from '../../bus/answer-worker.js'
import type { Lease } from '../../bus/lease.js'
import type { DetectionMode, Scope } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnswerNode } from '../../bus/answer-worker.js'
import { appendEvent } from '../../bus/db.js'
import { CARD_ANSWERED, CARD_STOPPED } from '../../bus/inbox.js'
import { failTask, leaseNext } from '../../bus/lease.js'
import { NODE_CURSORS, NODE_DETECTED, NODE_EQUIVALENCE } from '../../bus/node.js'
import { answerCandidates, FAILURES_TO_STOP, keyOf, TASK_ENQUEUED } from '../../bus/queue.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'

const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
})

class ProbedAnswerNode extends AnswerNode {
  failOnCall: number | null = null
  private calls = 0

  found(scope?: Scope): string[] {
    return this.candidates(scope).map(keyOf)
  }

  protected override candidates(scope?: Scope): QueuedTask[] {
    this.calls += 1
    if (this.calls === this.failOnCall)
      throw new Error('injected in the middle of a batch')
    return super.candidates(scope)
  }

  protected override async handle(lease: Lease): Promise<AnswerStep> {
    return { kind: 'fenced', taskKey: lease.taskKey }
  }

  failOnNextCall(after: number): void {
    this.failOnCall = this.calls + after
  }
}

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function nodeOf(made: MergeBench, mode: DetectionMode = 'shadow'): ProbedAnswerNode {
  const parts: AnswerNodeParts = { db: made.db, answerer: async () => {
    throw new Error('the probe answers nothing')
  }, ownerMerges: () => '', clock: made.clock.now, session: 'node-1', cardText: () => null, mode, env: {} }
  return new ProbedAnswerNode(parts)
}

async function once(node: AnswerNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function prKey(pr: number, head = sha('a')): string {
  return keyOf({ queue: 'answer', cardId: pr + 100, pr, head })
}

function questionKey(cardId: number, stop: number): string {
  return keyOf({ queue: 'answer', cardId, stop })
}

function stopped(made: MergeBench, cardId: number): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}:${made.clock.now().getTime()}`, payload: { reason: 'question.agent', detail: `a question on card #${cardId}` }, legacy: false })
  return lastEventOf(made, CARD_STOPPED)
}

function answered(made: MergeBench, cardId: number): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ANSWERED, actor: 'worker:answer:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_ANSWERED}:${cardId}`, payload: { session: 's', resumed: true, source: 'question', from: sha('a'), to: sha('e') }, legacy: false })
  return lastEventOf(made, CARD_ANSWERED)
}

function lastEventOf(made: MergeBench, type: string, pr?: number): number {
  const row = made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ? AND (? IS NULL OR pr = ?)').get(type, pr ?? null, pr ?? null) as { id: number | null }
  return Number(row.id)
}

function detected(made: MergeBench, via: 'event' | 'tick'): Record<string, unknown>[] {
  return eventsOf(made.db, NODE_DETECTED).filter(each => each.via === via)
}

function keysOf(made: MergeBench, via: 'event' | 'tick'): string[] {
  return detected(made, via).map(each => String(each.key)).sort()
}

function derivedKeys(made: MergeBench): string[] {
  return answerCandidates(made.db, made.clock.now().toISOString()).map(keyOf)
}

function answerTasks(made: MergeBench, cardId: number): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'answer' AND card_id = ?`).get(cardId) as { n: number }).n)
}

function enqueuedOf(made: MergeBench, key: string): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.task_key') = ?`).get(TASK_ENQUEUED, key) as { n: number }).n)
}

function cursorOf(made: MergeBench): number {
  return Number((made.db.prepare(`SELECT event_id FROM ${NODE_CURSORS} WHERE kind = 'answer'`).get() as { event_id: number }).event_id)
}

function openEach(made: MergeBench, base: number): string[] {
  made.gitHub.open({ number: base, review: 'failure' })
  made.gitHub.open({ number: base + 1, required: 'failure', failed: ['lint'] })
  made.gitHub.open({ number: base + 2, mergeable_state: 'dirty' })
  made.tick()
  return [prKey(base), prKey(base + 1), prKey(base + 2)]
}

describe('the answer node', () => {
  it('a question stop, a changes verdict, a red CI and a dirty pull request are each detected by their event and by a tick', async () => {
    const made = bench()
    const first = [...openEach(made, 990), questionKey(905, stopped(made, 905))]
    const node = nodeOf(made)
    await once(node)
    expect(keysOf(made, 'tick')).toEqual([...first].sort())
    expect(detected(made, 'event')).toEqual([])

    const second = [...openEach(made, 994), questionKey(906, stopped(made, 906))]
    await once(node)
    expect(keysOf(made, 'event')).toEqual([...first, ...second].sort())

    const third = stopped(made, 907)
    await once(node)
    expect(detected(made, 'event').find(each => each.key === questionKey(907, third))).toEqual({ key: questionKey(907, third), via: 'event', event_id: third })
  })

  it('a card.answered after a question stop takes the card out of the candidates, scoped by its card', async () => {
    const made = bench()
    const asked = stopped(made, 905)
    const other = stopped(made, 906)
    const node = nodeOf(made)
    await once(node)
    expect(node.found({ cardId: 905 })).toEqual([questionKey(905, asked)])

    answered(made, 905)
    expect(node.found()).toEqual([questionKey(906, other)])
    expect(node.found({ cardId: 905 })).toEqual([])
    expect(node.found({ cardId: 906 })).toEqual([questionKey(906, other)])

    const later = stopped(made, 907)
    await once(node)
    expect(detected(made, 'event')).toEqual([{ key: questionKey(907, later), via: 'event', event_id: later }])
  })

  it('the node and answerCandidates find one set on one snapshot, and shadow records node.equivalence with nothing on one side only', async () => {
    const made = bench()
    const fromPrs = openEach(made, 990)
    made.gitHub.open({ number: 997, review: 'failure' })
    made.tick()
    made.gitHub.close(997, false)
    made.tick()
    const question = questionKey(905, stopped(made, 905))
    const node = nodeOf(made)
    const keys = [...new Set(derivedKeys(made))].sort()

    expect(keys).toEqual(expect.arrayContaining([...fromPrs, question]))
    expect(keys).not.toContain(prKey(997))
    expect(node.found()).toEqual(derivedKeys(made))
    expect(node.found({ pr: 991 })).toEqual([prKey(991)])

    const enqueued = keys.map(key => enqueuedOf(made, key))
    await once(node)
    expect(eventsOf(made.db, NODE_EQUIVALENCE)).toEqual([{ same: keys, only_node: [], only_derive: [], event_id: expect.any(Number) as unknown }])
    expect(keys.map(key => enqueuedOf(made, key))).toEqual(enqueued)
  })

  it('i1: in live mode the node and deriveQueues detect one key, and there is one task row and one task.enqueued', async () => {
    const made = bench()
    const node = nodeOf(made, 'live')
    await once(node)
    expect(answerTasks(made, 905)).toBe(0)

    const key = questionKey(905, stopped(made, 905))
    await once(node)
    expect(enqueuedOf(made, key)).toBe(1)
    made.tick()
    await once(node)
    made.tick()

    expect(answerTasks(made, 905)).toBe(1)
    expect(enqueuedOf(made, key)).toBe(1)
  })

  it('i2: a failure in the middle of a batch rolls back the cursor with its records, and the restart detects each candidate once', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)
    const cursor = cursorOf(made)

    const first = stopped(made, 905)
    const second = stopped(made, 906)
    node.failOnNextCall(2)
    await expect(once(node)).rejects.toThrow('injected in the middle of a batch')
    expect(detected(made, 'event')).toEqual([])
    expect(cursorOf(made)).toBe(cursor)

    await once(node)
    await once(node)
    expect(detected(made, 'event')).toEqual([{ key: questionKey(905, first), via: 'event', event_id: first }, { key: questionKey(906, second), via: 'event', event_id: second }])
  })

  it('i3: a cursor reset to 0 gives no second detection and no second task', async () => {
    for (const mode of ['shadow', 'live'] as const) {
      const made = bench()
      const node = nodeOf(made, mode)
      await once(node)
      const [key] = openEach(made, 990)
      await once(node)
      await once(node)
      made.tick()
      const counts = (): object => ({ detected: eventsOf(made.db, NODE_DETECTED).length, enqueued: enqueuedOf(made, key!), tasks: answerTasks(made, 1090) })
      const before = counts()
      expect(enqueuedOf(made, key!), mode).toBe(1)

      made.db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = 0`).run()
      await once(node)
      made.tick()
      await once(node)
      expect(counts(), mode).toEqual(before)
    }
  })

  it('an answer stopped on no card tree is requeued and a task of an old head is superseded by deriveQueues beside the node as before', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)

    made.gitHub.open({ number: 1014, review: 'failure' })
    made.tick()
    for (let failure = 0; failure < FAILURES_TO_STOP; failure++)
      failTask(made.db, made.clock.now().toISOString(), leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:probe')!, { reason: 'no_card_tree', withdraw: false })
    expect(taskState(made.db, prKey(1014)).state).toBe('stopped')
    await once(node)
    made.tick()
    expect(taskState(made.db, prKey(1014))).toMatchObject({ state: 'queued', failures: 0 })

    made.gitHub.open({ number: 1016, review: 'failure' })
    made.tick()
    made.gitHub.pulls.get(1016)!.head = sha('b')
    await once(node)
    made.tick()
    expect(taskState(made.db, prKey(1016)).state).toBe('superseded')
  })
})

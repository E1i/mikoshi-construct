import type { CardStart, CardStarter, QueuedCard, StartedCard } from '../../bus/launch-executor.js'
import type { LaunchNodeParts, LaunchStep } from '../../bus/launch-worker.js'
import type { Lease } from '../../bus/lease.js'
import type { DetectionMode } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../bus/db.js'
import { CARD_STARTED, CARD_STOPPED } from '../../bus/inbox.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { LaunchNode } from '../../bus/launch-worker.js'
import { NODE_CURSORS, NODE_DETECTED, NODE_EQUIVALENCE } from '../../bus/node.js'
import { PR_CLOSED } from '../../bus/observations.js'
import { keyOf, launchTasks, TASK_ENQUEUED } from '../../bus/queue.js'
import { reduce } from '../../bus/reducer.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'
import { detectReview } from './review-detection.js'

const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
})

class FakeStarter implements CardStarter {
  starts: QueuedCard[] = []
  stops: StartedCard[] = []

  start(card: QueuedCard): CardStart {
    this.starts.push(card)
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(card: StartedCard): void {
    this.stops.push(card)
  }
}

class ProbedLaunchNode extends LaunchNode {
  failOnCall: number | null = null
  private calls = 0

  found(): string[] {
    return this.candidates().map(keyOf)
  }

  protected override candidates(): QueuedTask[] {
    this.calls += 1
    if (this.calls === this.failOnCall)
      throw new Error('injected in the middle of a batch')
    return super.candidates()
  }

  failOnNextCall(after: number): void {
    this.failOnCall = this.calls + after
  }
}

class DetectingLaunchNode extends ProbedLaunchNode {
  protected override handle(lease: Lease): LaunchStep {
    return { kind: 'fenced', taskKey: lease.taskKey }
  }
}

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function nodeOf(made: MergeBench, mode: DetectionMode = 'shadow', starter: CardStarter = new FakeStarter()): ProbedLaunchNode {
  const parts: LaunchNodeParts = { db: made.db, starter, clock: made.clock.now, session: 'node-1', mode, env: {} }
  return new DetectingLaunchNode(parts)
}

async function once(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function launchKey(cardId: number): string {
  return keyOf({ queue: 'launch', cardId, generation: `admission-${cardId}` })
}

function admit(made: MergeBench, cardId: number, lane: string, depends: number[] = []): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane, decision: 'auto', contour: 'cheap', depends, admission: `admission-${cardId}` }, legacy: false })
  return lastEventOf(made, CARD_ADMITTED)
}

function stopped(made: MergeBench, cardId: number): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}`, payload: { reason: 'question.owner' }, legacy: false })
  return lastEventOf(made, CARD_STOPPED)
}

function startedEarlier(made: MergeBench, cardId: number): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${cardId}`, payload: { session: 'earlier' }, legacy: false })
}

function mergedWithoutDerive(made: MergeBench, pr: number): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_CLOSED, actor: 'netwatch', cardId: pr + 100, pr, head: null, dedupeKey: `${PR_CLOSED}:${pr}:merged`, payload: { merged: true }, legacy: false })
  reduce(made.db)
  return lastEventOf(made, PR_CLOSED)
}

function lastEventOf(made: MergeBench, type: string): number {
  const row = made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(type) as { id: number | null }
  return Number(row.id)
}

function byEvent(made: MergeBench): Record<string, unknown>[] {
  return eventsOf(made.db, NODE_DETECTED).filter(each => each.via === 'event')
}

function derivedKeys(made: MergeBench): string[] {
  return launchTasks(made.db).map(keyOf)
}

function launchRows(made: MergeBench, cardId: number): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'launch' AND card_id = ?`).get(cardId) as { n: number }).n)
}

function enqueuedOf(made: MergeBench, key: string): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.task_key') = ?`).get(TASK_ENQUEUED, key) as { n: number }).n)
}

function cursorOf(made: MergeBench): number {
  return Number((made.db.prepare(`SELECT event_id FROM ${NODE_CURSORS} WHERE kind = 'launch'`).get() as { event_id: number }).event_id)
}

describe('the launch node', () => {
  it('an admitted card with a free lane and a depends settled by a merge are each detected by their event and by a tick', async () => {
    const made = bench()
    const earlier = bench()
    admit(earlier, 912, 'lane-c')
    await once(nodeOf(earlier))
    expect(eventsOf(earlier.db, NODE_DETECTED)).toEqual([{ key: launchKey(912), via: 'tick', event_id: expect.any(Number) as unknown }])

    made.gitHub.open({ number: 990 })
    made.tick()
    const node = nodeOf(made)
    await once(node)
    const free = admit(made, 910, 'lane-a')
    admit(made, 911, 'lane-b', [1090])
    await once(node)
    expect(byEvent(made)).toEqual([{ key: launchKey(910), via: 'event', event_id: free }])

    const merge = mergedWithoutDerive(made, 990)
    await once(node)
    expect(byEvent(made)).toEqual([{ key: launchKey(910), via: 'event', event_id: free }, { key: launchKey(911), via: 'event', event_id: merge }])
  })

  it('an event of card A changes the candidate of card B in the same lane: the node recomputes the whole queue on every event', async () => {
    const made = bench()
    admit(made, 920, 'lane-a')
    admit(made, 921, 'lane-a')
    const node = nodeOf(made)
    await once(node)
    expect(node.found()).toEqual([launchKey(920)])

    const proof = stopped(made, 920)
    await once(node)
    expect(byEvent(made)).toEqual([{ key: launchKey(921), via: 'event', event_id: proof }])
    expect(node.found()).toEqual([launchKey(921)])
  })

  it('the node and launchTasks find one set on one snapshot, and shadow records node.equivalence with nothing on one side only', async () => {
    const made = bench()
    admit(made, 930, 'lane-a')
    admit(made, 931, 'lane-a')
    admit(made, 932, 'lane-b', [1090])
    admit(made, 933, 'lane-c')
    startedEarlier(made, 933)
    const node = nodeOf(made)
    const keys = [launchKey(930)]

    expect(node.found()).toEqual(keys)
    expect(node.found()).toEqual(derivedKeys(made))

    const enqueued = keys.map(key => enqueuedOf(made, key))
    await once(node)
    expect(eventsOf(made.db, NODE_EQUIVALENCE)).toEqual([{ same: keys, only_node: [], only_derive: [], event_id: expect.any(Number) as unknown }])
    expect(keys.map(key => enqueuedOf(made, key))).toEqual(enqueued)
  })

  it('i1: in live mode the node and deriveQueues detect one key, and there is one task row and one task.enqueued', async () => {
    const made = bench()
    const node = nodeOf(made, 'live')
    await once(node)

    admit(made, 940, 'lane-a')
    await once(node)
    expect(enqueuedOf(made, launchKey(940))).toBe(1)
    made.tick()
    await once(node)
    made.tick()

    expect(launchRows(made, 940)).toBe(1)
    expect(enqueuedOf(made, launchKey(940))).toBe(1)
  })

  it('i2: a failure in the middle of a batch rolls back the cursor with its records, and the restart detects each candidate once', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)
    const cursor = cursorOf(made)

    const first = admit(made, 950, 'lane-a')
    admit(made, 951, 'lane-b')
    node.failOnNextCall(2)
    await expect(once(node)).rejects.toThrow('injected in the middle of a batch')
    expect(byEvent(made)).toEqual([])
    expect(cursorOf(made)).toBe(cursor)

    await once(node)
    expect(byEvent(made)).toEqual([{ key: launchKey(950), via: 'event', event_id: first }, { key: launchKey(951), via: 'event', event_id: first }])
  })

  it('i3: a cursor reset to 0 gives no second detection and no second task', async () => {
    for (const mode of ['shadow', 'live'] as const) {
      const made = bench()
      const node = nodeOf(made, mode)
      await once(node)
      admit(made, 960, 'lane-a')
      await once(node)
      made.tick()
      const counts = (): object => ({ detected: eventsOf(made.db, NODE_DETECTED).length, enqueued: enqueuedOf(made, launchKey(960)), tasks: launchRows(made, 960) })
      await once(node)
      const before = counts()

      made.db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = 0`).run()
      await once(node)
      made.tick()
      await once(node)
      expect(counts(), mode).toEqual(before)
    }
  })

  it('the launch node takes one task at a time in arrival order and starts it through the LaunchExecutor and its starter as the worker did', async () => {
    const made = bench()
    const starter = new FakeStarter()
    admit(made, 970, 'lane-a')
    admit(made, 971, 'lane-b')
    made.tick()
    const node = new ProbedLaunchNode({ db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'shadow', env: {} })
    expect(node.slots).toBe(1)

    await once(node)
    expect(starter.starts.map(card => card.cardId)).toEqual([970])
    expect(taskState(made.db, launchKey(970))).toMatchObject({ state: 'completed' })
    expect(taskState(made.db, launchKey(971))).toMatchObject({ state: 'queued' })
    expect(eventsOf(made.db, CARD_STARTED)).toEqual([{ session: 's-970', worktree: '/trees/mc-970', branch: 'feat/card-970', base: 'f'.repeat(40), pid: 4242, pgid: 4242 }])

    await once(node)
    expect(starter.starts.map(card => card.cardId)).toEqual([970, 971])
  })

  it('a task of an old head is superseded by deriveQueues beside the launch node as before', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)

    made.gitHub.open({ number: 980 })
    made.tick()
    detectReview(made)
    made.gitHub.pulls.get(980)!.head = sha('b')
    made.tick()
    detectReview(made)
    await once(node)

    const rows = made.db.prepare(`SELECT head, state FROM tasks WHERE queue = 'review' AND pr = 980 ORDER BY id`).all()
    expect(rows).toEqual([{ head: sha('a'), state: 'superseded' }, { head: sha('b'), state: 'queued' }])
    expect(eventsOf(made.db, NODE_DETECTED).filter(detected => !String(detected.key).startsWith('review:'))).toEqual([])
  })
})

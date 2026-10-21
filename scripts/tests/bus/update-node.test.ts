import type { DetectionMode, Scope } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import type { UpdateNodeParts } from '../../bus/update-worker.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { DROPPED_LANE } from '../../bus/card-automaton.js'
import { appendEvent } from '../../bus/db.js'
import { NODE_CURSORS } from '../../bus/node.js'
import { keyOf, updateCandidates } from '../../bus/queue.js'
import { UpdateNode } from '../../bus/update-worker.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_MOVED, COMMAND_EXECUTED, MERGE_DONE, NODE_DETECTED, NODE_EQUIVALENCE, POLICY_ALLOWED, POLICY_DENIED, REVIEW_RECORDED, TASK_ENQUEUED } from '../../core/events.js'
import { MAIN_2, sha } from './github-fake.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const UPDATE_DONE = 'update.done'
const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const bench of benches.splice(0))
    bench.close()
})

class ProbedUpdateNode extends UpdateNode {
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

  failOnNextCall(after: number): void {
    this.failOnCall = this.calls + after
  }
}

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
  return made
}

function nodeOf(made: MergeBench, mode: DetectionMode = 'shadow'): ProbedUpdateNode {
  const parts: UpdateNodeParts = { db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, settle: () => {}, session: 'node-1', mode, env: {} }
  return new ProbedUpdateNode(parts)
}

async function once(node: UpdateNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function updateKey(pr: number, head = sha('a')): string {
  return keyOf({ queue: 'update', cardId: pr + 100, pr, head })
}

function derivedKeys(made: MergeBench): string[] {
  return updateCandidates(made.db, made.clock.now().toISOString()).map(keyOf)
}

function deniedByAuthority(made: MergeBench, pr: number): number {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: POLICY_DENIED, actor: 'policy', cardId: pr + 100, pr, head: sha('a'), dedupeKey: `${POLICY_DENIED}:owner-${pr}`, payload: { command: 'merge', kind: 'authority', rule: 'owner_by_risk', detail: 'stays the owner\'s' }, legacy: false })
  return lastEventOf(made, POLICY_DENIED)
}

function lastEventOf(made: MergeBench, type: string, pr?: number): number {
  const row = made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ? AND (? IS NULL OR pr = ?)').get(type, pr ?? null, pr ?? null) as { id: number | null }
  return Number(row.id)
}

function byEvent(made: MergeBench): Record<string, unknown>[] {
  return eventsOf(made.db, NODE_DETECTED).filter(each => each.via === 'event')
}

function detectedKeysBy(made: MergeBench, node: UpdateNode): unknown[] {
  return made.db.prepare('SELECT payload FROM events WHERE type = ? AND actor = ? ORDER BY id').all(NODE_DETECTED, node.actor).map(row => (JSON.parse(String(row.payload)) as Record<string, unknown>).key)
}

function updateTasks(made: MergeBench, pr: number): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'update' AND pr = ?`).get(pr) as { n: number }).n)
}

function enqueuedOf(made: MergeBench, key: string): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.task_key') = ?`).get(TASK_ENQUEUED, key) as { n: number }).n)
}

function cursorOf(made: MergeBench): number {
  return Number((made.db.prepare(`SELECT event_id FROM ${NODE_CURSORS} WHERE kind = 'update'`).get() as { event_id: number }).event_id)
}

function admitted(made: MergeBench, cardId: number): void {
  const text = `card: #${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nUpdate it.\n`
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${cardId}`, payload: { card: `#${cardId}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
}

function dropped(made: MergeBench, cardId: number): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_MOVED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_MOVED}:${cardId}`, payload: { lane: DROPPED_LANE }, legacy: false })
}

function closedAfterAnEarlierMerge(made: MergeBench, cardId: number): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: MERGE_DONE, actor: 'worker:merge:worker-0', cardId, pr: 979, head: sha('e'), dedupeKey: `${MERGE_DONE}:979`, payload: { commit: sha('f'), rule: 'auto' }, legacy: false })
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:worker-0', cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { verification: 'run' }, legacy: false })
}

const NOT_MINE: Record<string, (made: MergeBench, cardId: number) => void> = { dropped, closed: closedAfterAnEarlierMerge }

describe('the update node', () => {
  it('a behind pull request with a pass is detected by its pr.observed and by a tick', async () => {
    const made = bench()
    made.gitHub.open({ number: 980, review: 'success', mergeable_state: 'behind' })
    made.tick()
    const node = nodeOf(made, 'live')
    await once(node)
    expect(eventsOf(made.db, NODE_DETECTED)).toEqual([{ key: updateKey(980), via: 'tick', event_id: expect.any(Number) as unknown, outcome: 'queued' }])

    made.gitHub.open({ number: 981, review: 'success', mergeable_state: 'behind' })
    made.tick()
    await once(node)
    expect(byEvent(made)).toEqual([{ key: updateKey(981), via: 'event', event_id: lastEventOf(made, 'pr.observed', 981), outcome: 'queued' }])
  })

  it('main.advanced alone detects nothing, and the pr.observed that brings behind detects the pull request', async () => {
    const made = bench()
    made.gitHub.open({ number: 970, review: 'success' })
    made.tick()
    const node = nodeOf(made)
    await once(node)

    made.gitHub.main = MAIN_2
    made.tick()
    expect(lastEventOf(made, 'main.advanced')).toBeGreaterThan(0)
    await once(node)
    expect(eventsOf(made.db, NODE_DETECTED)).toEqual([])

    made.gitHub.pulls.get(970)!.mergeable_state = 'behind'
    made.tick()
    await once(node)
    expect(byEvent(made)).toEqual([{ key: updateKey(970), via: 'event', event_id: lastEventOf(made, 'pr.observed', 970) }])
  })

  it('a policy.denied of kind authority on a behind pull request without a pass detects nothing', async () => {
    const made = bench()
    made.gitHub.open({ number: 981, mergeable_state: 'behind' })
    made.gitHub.open({ number: 982, mergeable_state: 'behind' })
    made.tick()
    const node = nodeOf(made)
    await once(node)
    expect(node.found()).toEqual([])

    deniedByAuthority(made, 981)
    await once(node)
    expect(byEvent(made)).toEqual([])
    expect(node.found({ cardId: 1081 })).toEqual([])
    expect(node.found({ cardId: 1082 })).toEqual([])
  })

  it('of two behind pull requests with a pass only the older is detected, scoped by its card', async () => {
    const made = bench()
    made.gitHub.open({ number: 981, review: 'success', mergeable_state: 'behind' })
    made.gitHub.open({ number: 982, review: 'success', mergeable_state: 'behind' })
    made.tick()
    const node = nodeOf(made)
    await once(node)

    expect(node.found()).toEqual([updateKey(981)])
    expect(node.found({ cardId: 1081 })).toEqual([updateKey(981)])
    expect(node.found({ cardId: 1082 })).toEqual([])
  })

  it('the node and updateCandidates find one set on one snapshot, and shadow records node.equivalence with nothing on one side only', async () => {
    const made = bench()
    made.gitHub.open({ number: 980, review: 'success', mergeable_state: 'behind' })
    made.gitHub.open({ number: 981, head: sha('c'), mergeable_state: 'behind' })
    made.gitHub.open({ number: 982, head: sha('d'), mergeable_state: 'behind' })
    made.gitHub.open({ number: 984, head: sha('e'), review: 'success' })
    deniedByAuthority(made, 981)
    made.tick()
    const node = nodeOf(made)
    const keys = [updateKey(980)]

    expect(node.found()).toEqual(keys)
    expect(node.found()).toEqual(derivedKeys(made))
    expect(node.found({ pr: 981 })).toEqual([])

    made.gitHub.updateStatus = 409
    const enqueued = keys.map(key => enqueuedOf(made, key))
    await once(node)
    expect(eventsOf(made.db, NODE_EQUIVALENCE)).toEqual([{ same: keys, only_node: [], only_derive: [], event_id: expect.any(Number) as unknown }])
    expect(keys.map(key => enqueuedOf(made, key))).toEqual(enqueued)
  })

  it('i1: in live mode the node and deriveQueues detect one key, and there is one task row and one task.enqueued', async () => {
    const made = bench()
    made.gitHub.open({ number: 981, review: 'success', mergeable_state: 'behind' })
    made.gitHub.updateStatus = 409
    made.tick()
    const node = nodeOf(made, 'live')
    await once(node)
    expect(enqueuedOf(made, updateKey(981))).toBe(1)
    made.tick()
    made.gitHub.updateStatus = 202
    await once(node)

    expect(updateTasks(made, 981)).toBe(1)
    expect(enqueuedOf(made, updateKey(981))).toBe(1)
    expect(eventsOf(made.db, UPDATE_DONE)).toHaveLength(1)
  })

  it('i2: a failure in the middle of a batch rolls back the cursor with its records, and the restart detects the candidate once', async () => {
    const made = bench()
    made.gitHub.open({ number: 981, review: 'success' })
    made.gitHub.open({ number: 982, review: 'success' })
    made.tick()
    const node = nodeOf(made)
    await once(node)
    const cursor = cursorOf(made)

    made.gitHub.pulls.get(981)!.mergeable_state = 'behind'
    made.gitHub.pulls.get(982)!.mergeable_state = 'behind'
    made.tick()
    const first = lastEventOf(made, 'pr.observed', 981)
    node.failOnNextCall(2)
    await expect(once(node)).rejects.toThrow('injected in the middle of a batch')
    expect(byEvent(made)).toEqual([])
    expect(cursorOf(made)).toBe(cursor)

    await once(node)
    await once(node)
    expect(byEvent(made)).toEqual([{ key: updateKey(981), via: 'event', event_id: first }])
  })

  it('i3: a cursor reset to 0 gives no second detection and no second task', async () => {
    for (const mode of ['live'] as const) {
      const made = bench()
      made.gitHub.open({ number: 980, review: 'success', mergeable_state: 'behind' })
      made.tick()
      const node = nodeOf(made, mode)
      await once(node)
      await once(node)
      made.tick()
      const counts = (): object => ({ detected: eventsOf(made.db, NODE_DETECTED).length, enqueued: enqueuedOf(made, updateKey(980)), done: eventsOf(made.db, UPDATE_DONE).length })
      const before = counts()
      expect(eventsOf(made.db, UPDATE_DONE), mode).toHaveLength(1)

      made.db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = 0`).run()
      await once(node)
      made.tick()
      await once(node)
      expect(counts(), mode).toEqual(before)
    }
  })

  it('a queued update task of an old head is superseded by deriveQueues beside the node as before', async () => {
    const made = bench()
    const node = nodeOf(made, 'live')
    await once(node)

    made.gitHub.open({ number: 980, review: 'success', mergeable_state: 'behind' })
    made.tick()
    detectUpdate(made)
    expect(taskState(made.db, updateKey(980)).state).toBe('queued')
    made.gitHub.pulls.get(980)!.head = sha('b')
    made.tick()
    await once(node)

    expect(taskState(made.db, updateKey(980)).state).toBe('superseded')
    expect(detectedKeysBy(made, node)).not.toContain(updateKey(980))
    expect(made.gitHub.puts.map(put => put.fields.expected_head_sha)).toEqual([sha('b')])
  })

  it('every write to GitHub is followed by command.executed with its result', async () => {
    const made = bench()
    made.gitHub.open({ number: 970, review: 'success', mergeable_state: 'behind' })
    made.tick()
    const node = nodeOf(made, 'live')
    await once(node)
    await once(node)

    const law = made.db.prepare(`SELECT type, payload FROM events WHERE type IN (?, ?, ?) ORDER BY id`).all(POLICY_ALLOWED, COMMAND_EXECUTED, UPDATE_DONE).map(row => ({ type: row.type, ...(JSON.parse(String(row.payload)) as Record<string, unknown>) }))
    const lease = { task_key: updateKey(970), lease_gen: 1 }
    expect(made.gitHub.puts.map(each => each.endpoint)).toEqual(['repos/{owner}/{repo}/pulls/970/update-branch'])
    expect(made.gitHub.published).toHaveLength(1)
    expect(law).toEqual([
      { type: POLICY_ALLOWED, command: 'update_branch', ...lease },
      { type: COMMAND_EXECUTED, command: 'update_branch', ok: true, status: 202, ...lease },
      { type: COMMAND_EXECUTED, command: 'publish', ok: true, ...lease },
      expect.objectContaining({ type: UPDATE_DONE, carried: 'pass', clean: true, ...lease }),
    ])
  })

  it('update skips a candidate cardContract reads as not mine', async () => {
    for (const [state, endedInTheBus] of Object.entries(NOT_MINE)) {
      const made = bench()
      admitted(made, 1080)
      made.gitHub.open({ number: 980, review: 'success', mergeable_state: 'behind' })
      made.tick()
      detectUpdate(made)
      endedInTheBus(made, 1080)
      made.tick()
      const node = nodeOf(made, 'live')
      const asked = made.gitHub.calls.length
      await once(node)
      await once(node)

      expect(made.gitHub.calls.slice(asked), state).toEqual([])
      expect(made.gitHub.puts, state).toEqual([])
      expect(eventsOf(made.db, UPDATE_DONE), state).toEqual([])
      expect(eventsOf(made.db, POLICY_DENIED), state).toEqual([expect.objectContaining({ command: 'update_branch', kind: 'technical', reason: 'not_mine', detail: expect.stringContaining(`is ${state} in the bus`) })])
      expect(taskState(made.db, updateKey(980)).state, state).toBe('withdrawn')
    }
  })
})

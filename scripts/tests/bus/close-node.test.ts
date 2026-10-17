import type { CardTreeRemover } from '../../bus/close-executor.js'
import type { CloseNodeParts } from '../../bus/close-worker.js'
import type { EndedTree } from '../../bus/ended-card-trees.js'
import type { DetectionMode, Scope } from '../../bus/node.js'
import type { QueuedTask } from '../../bus/queue.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseNode } from '../../bus/close-worker.js'
import { appendEvent } from '../../bus/db.js'
import { CARD_STARTED } from '../../bus/inbox.js'
import { NODE_CURSORS, NODE_DETECTED, NODE_EQUIVALENCE } from '../../bus/node.js'
import { BOARD_ALARM, CARD_CLOSED, closeCandidates, keyOf, TASK_ENQUEUED } from '../../bus/queue.js'
import { TREE_LEFT } from '../../bus/review-worker.js'
import { CARD_VERIFIED } from '../../ghosts/task-close.js'
import { sha } from './github-fake.js'
import { cardVerified, eventsOf, mergeBench } from './merge-bench.js'

interface CloseBench extends MergeBench {
  root: string
}

const benches: CloseBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0)) {
    made.close()
    rmSync(made.root, { recursive: true, force: true })
  }
})

class ProbedCloseNode extends CloseNode {
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

function bench(): CloseBench {
  const made = { ...mergeBench(), root: mkdtempSync(path.join(tmpdir(), 'bus-close-node-')) }
  benches.push(made)
  return made
}

interface NodeOptions {
  mode?: DetectionMode
  reported?: () => string | null
  trees?: CardTreeRemover
  endedTrees?: () => EndedTree[]
}

function nodeOf(made: CloseBench, options: NodeOptions = {}): ProbedCloseNode {
  const parts: CloseNodeParts = { db: made.db, reported: options.reported ?? (() => 'run'), clock: made.clock.now, session: 'node-1', journal: path.join(made.root, 'ghosts.jsonl'), parking: path.join(made.root, 'parking'), mode: options.mode ?? 'shadow', env: {}, trees: options.trees ?? { remove: () => null }, endedTrees: options.endedTrees }
  return new ProbedCloseNode(parts)
}

async function once(node: CloseNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function closeKey(pr: number, head = sha('a')): string {
  return keyOf({ queue: 'close', cardId: pr + 100, pr, head })
}

function verified(made: CloseBench, pr: number): number {
  cardVerified(made.db, made.clock.now().toISOString(), pr + 100, pr)
  return lastEventOf(made, CARD_VERIFIED, pr)
}

function opened(made: CloseBench, ...prs: number[]): void {
  for (const pr of prs)
    made.gitHub.open({ number: pr })
  made.tick()
}

function merged(made: CloseBench, ...prs: number[]): void {
  for (const pr of prs)
    made.gitHub.close(pr, true)
  made.tick()
}

function closedEarlier(made: CloseBench, cardId: number): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { verification: 'run' }, legacy: false })
}

function lastEventOf(made: CloseBench, type: string, pr?: number): number {
  const row = made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ? AND (? IS NULL OR pr = ?)').get(type, pr ?? null, pr ?? null) as { id: number | null }
  return Number(row.id)
}

function byEvent(made: CloseBench): Record<string, unknown>[] {
  return eventsOf(made.db, NODE_DETECTED).filter(each => each.via === 'event')
}

function derivedKeys(made: CloseBench): string[] {
  return closeCandidates(made.db, made.clock.now().toISOString()).map(keyOf)
}

function closeTasks(made: CloseBench, pr: number): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'close' AND pr = ?`).get(pr) as { n: number }).n)
}

function enqueuedOf(made: CloseBench, key: string): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM events WHERE type = ? AND json_extract(payload, '$.task_key') = ?`).get(TASK_ENQUEUED, key) as { n: number }).n)
}

function cursorOf(made: CloseBench): number {
  return Number((made.db.prepare(`SELECT event_id FROM ${NODE_CURSORS} WHERE kind = 'close'`).get() as { event_id: number }).event_id)
}

function taskStatesOf(made: CloseBench, queue: string, pr: number): { head: string, state: string }[] {
  return made.db.prepare('SELECT head, state FROM tasks WHERE queue = ? AND pr = ? ORDER BY id').all(queue, pr) as unknown as { head: string, state: string }[]
}

describe('the close node', () => {
  it('a merged pull request with card.verified is detected by its pr.closed and by a tick', async () => {
    const made = bench()
    opened(made, 990)
    verified(made, 990)
    merged(made, 990)
    const node = nodeOf(made, { mode: 'live' })
    await once(node)
    expect(eventsOf(made.db, NODE_DETECTED)).toEqual([{ key: closeKey(990), via: 'tick', event_id: expect.any(Number) as unknown, outcome: 'queued' }])

    opened(made, 991)
    verified(made, 991)
    await once(node)
    expect(byEvent(made)).toEqual([])
    merged(made, 991)
    await once(node)
    expect(byEvent(made)).toEqual([{ key: closeKey(991), via: 'event', event_id: lastEventOf(made, 'pr.closed', 991), outcome: 'queued' }])
  })

  it('a card.verified written after the merge is detected by event, scoped by its card', async () => {
    const made = bench()
    opened(made, 988, 989)
    merged(made, 988, 989)
    const node = nodeOf(made)
    await once(node)
    expect(node.found()).toEqual([])

    const proof = verified(made, 988)
    await once(node)
    expect(byEvent(made)).toEqual([{ key: closeKey(988), via: 'event', event_id: proof }])
    expect(node.found({ cardId: 1088 })).toEqual([closeKey(988)])
    expect(node.found({ cardId: 1089 })).toEqual([])
  })

  it('a card.closed or a pull request closed without merge detects nothing', async () => {
    const made = bench()
    opened(made, 991, 992)
    const node = nodeOf(made)
    await once(node)

    verified(made, 991)
    verified(made, 992)
    closedEarlier(made, 1092)
    made.gitHub.close(991, false)
    merged(made, 992)
    await once(node)

    expect(node.found()).toEqual([])
    expect(eventsOf(made.db, NODE_DETECTED)).toEqual([])
  })

  it('the node and closeCandidates find one set on one snapshot, and shadow records node.equivalence with nothing on one side only', async () => {
    const made = bench()
    opened(made, 990, 991, 992, 993, 994)
    for (const pr of [990, 992, 993, 994])
      verified(made, pr)
    closedEarlier(made, 1092)
    merged(made, 990, 991, 992, 994)
    const node = nodeOf(made, { reported: () => null })
    const keys = [closeKey(990), closeKey(994)]

    expect(node.found()).toEqual(keys)
    expect(node.found()).toEqual(derivedKeys(made))
    expect(node.found({ pr: 994 })).toEqual([closeKey(994)])

    const enqueued = keys.map(key => enqueuedOf(made, key))
    await once(node)
    expect(eventsOf(made.db, NODE_EQUIVALENCE)).toEqual([{ same: keys, only_node: [], only_derive: [], event_id: expect.any(Number) as unknown }])
    expect(keys.map(key => enqueuedOf(made, key))).toEqual(enqueued)
  })

  it('i1: in live mode the node detects one key, deriveQueues enqueues no close task, and there is one task row, one task.enqueued and one card.closed', async () => {
    const made = bench()
    opened(made, 990)
    merged(made, 990)
    let reported: string | null = null
    const node = nodeOf(made, { mode: 'live', reported: () => reported })
    await once(node)
    expect(closeTasks(made, 990)).toBe(0)

    verified(made, 990)
    await once(node)
    expect(enqueuedOf(made, closeKey(990))).toBe(1)
    expect(eventsOf(made.db, CARD_CLOSED)).toEqual([])
    made.tick()
    reported = 'run'
    await once(node)
    made.tick()
    await once(node)

    expect(closeTasks(made, 990)).toBe(1)
    expect(enqueuedOf(made, closeKey(990))).toBe(1)
    expect(eventsOf(made.db, CARD_CLOSED)).toEqual([{ verification: 'run' }])
  })

  it('i2: a failure in the middle of a batch rolls back the cursor with its records, and the restart detects each candidate once', async () => {
    const made = bench()
    opened(made, 988, 989)
    merged(made, 988, 989)
    const node = nodeOf(made)
    await once(node)
    const cursor = cursorOf(made)

    const first = verified(made, 988)
    const second = verified(made, 989)
    node.failOnNextCall(2)
    await expect(once(node)).rejects.toThrow('injected in the middle of a batch')
    expect(byEvent(made)).toEqual([])
    expect(cursorOf(made)).toBe(cursor)

    await once(node)
    await once(node)
    expect(byEvent(made)).toEqual([{ key: closeKey(988), via: 'event', event_id: first }, { key: closeKey(989), via: 'event', event_id: second }])
  })

  it('i3: a cursor reset to 0 gives no second detection, no second task and no second card.closed', async () => {
    for (const mode of ['live'] as const) {
      const made = bench()
      opened(made, 990)
      verified(made, 990)
      merged(made, 990)
      const node = nodeOf(made, { mode })
      await once(node)
      await once(node)
      made.tick()
      const counts = (): object => ({ detected: eventsOf(made.db, NODE_DETECTED).length, enqueued: enqueuedOf(made, closeKey(990)), tasks: closeTasks(made, 990), closed: eventsOf(made.db, CARD_CLOSED).length })
      const before = counts()
      expect(eventsOf(made.db, CARD_CLOSED), mode).toHaveLength(1)

      made.db.prepare(`UPDATE ${NODE_CURSORS} SET event_id = 0`).run()
      await once(node)
      made.tick()
      await once(node)
      expect(counts(), mode).toEqual(before)
    }
  })

  it('a queued review task of an old head is superseded by deriveQueues beside the close node as before', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)

    opened(made, 980)
    expect(taskStatesOf(made, 'review', 980)).toEqual([{ head: sha('a'), state: 'queued' }])
    made.gitHub.pulls.get(980)!.head = sha('b')
    made.tick()
    await once(node)

    expect(taskStatesOf(made, 'review', 980)).toEqual([{ head: sha('a'), state: 'superseded' }, { head: sha('b'), state: 'queued' }])
    expect(eventsOf(made.db, NODE_DETECTED)).toEqual([])
  })

  it('the node frees ended trees once before its loop and on every lease, and records a tree left after closed', async () => {
    const made = bench()
    const worktree = '/trees/mc-1090'
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId: 1090, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-1090`, payload: { session: 's', worktree, branch: 'feat/card-1090', base: 'f'.repeat(40), pid: 1, pgid: 1 }, legacy: false })
    opened(made, 990)
    verified(made, 990)
    merged(made, 990)
    let passes = 0
    const node = nodeOf(made, {
      mode: 'live',
      trees: { remove: () => {
        throw Object.assign(new Error('Command failed: git worktree remove'), { stderr: 'fatal: modified files\n' })
      } },
      endedTrees: () => {
        passes += 1
        return []
      },
    })

    await once(node)
    expect(passes).toBe(2)
    expect(eventsOf(made.db, CARD_CLOSED)).toEqual([{ verification: 'run' }])
    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([{ reason: TREE_LEFT, path: worktree, detail: 'fatal: modified files' }])

    await once(node)
    expect(passes).toBe(3)
  })
})

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
import { textSha } from '../../../src/card/text-sha.js'
import { CARD_MOVED } from '../../../src/commands/intake/index.js'
import { DROPPED_LANE } from '../../bus/card-automaton.js'
import { ARTIFACT_REMOVED, CloseExecutor } from '../../bus/close-executor.js'
import { CloseNode } from '../../bus/close-worker.js'
import { appendEvent } from '../../bus/db.js'
import { CARD_STARTED, POLICY_DENIED } from '../../bus/inbox.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { completeTask, failTask, leaseNext, StaleLease } from '../../bus/lease.js'
import { NODE_CURSORS, NODE_DETECTED, NODE_EQUIVALENCE } from '../../bus/node.js'
import { BOARD_ALARM, CARD_CLOSED, closeCandidates, FAILURES_TO_STOP, keyOf, queueTask, TASK_ENQUEUED } from '../../bus/queue.js'
import { TREE_LEFT } from '../../bus/review-worker.js'
import { CARD_VERIFIED } from '../../ghosts/task-close.js'
import { sha } from './github-fake.js'
import { cardVerified, eventsOf, mergeBench } from './merge-bench.js'
import { detectReview } from './review-detection.js'

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

function probeVerified(made: CloseBench, cardId: number, payload: Record<string, unknown>): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_VERIFIED, actor: 'worker:task-close:window', cardId, pr: null, head: null, dedupeKey: `${CARD_VERIFIED}:${cardId}`, payload, legacy: false })
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

function admittedBody(made: CloseBench, cardId: number): void {
  const text = `card: #${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nClose it.\n`
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${cardId}`, payload: { card: `#${cardId}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
}

function cardStateOf(made: CloseBench, cardId: number): string | null {
  return (made.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string | null } | undefined)?.state ?? null
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

  it('a closed pull request has its tasks taken off', async () => {
    const made = bench()
    opened(made, 980)
    detectReview(made)
    const ts = made.clock.now().toISOString()
    queueTask(made.db, ts, { queue: 'answer', cardId: 1080, pr: 980, head: sha('a') })
    const held = leaseNext(made.db, ts, 'answer', 'worker:answer:worker-1')!
    queueTask(made.db, ts, { queue: 'merge', cardId: 1080, pr: 980, head: sha('a') })
    for (let failure = 1; failure <= FAILURES_TO_STOP; failure += 1)
      failTask(made.db, ts, leaseNext(made.db, ts, 'merge', 'worker:merge:worker-1')!, { reason: 'not_mergeable', withdraw: false })
    expect(taskStatesOf(made, 'review', 980)).toEqual([{ head: sha('a'), state: 'queued' }])
    expect(taskStatesOf(made, 'answer', 980)).toEqual([{ head: sha('a'), state: 'leased' }])
    expect(taskStatesOf(made, 'merge', 980)).toEqual([{ head: sha('a'), state: 'stopped' }])
    made.gitHub.close(980, false)
    made.tick()
    await once(nodeOf(made))

    expect(taskStatesOf(made, 'review', 980)).toEqual([{ head: sha('a'), state: 'withdrawn' }])
    expect(taskStatesOf(made, 'answer', 980)).toEqual([{ head: sha('a'), state: 'withdrawn' }])
    expect(taskStatesOf(made, 'merge', 980)).toEqual([{ head: sha('a'), state: 'withdrawn' }])
    expect(() => completeTask(made.db, made.clock.now().toISOString(), held, [])).toThrow(StaleLease)
  })

  it('close needs no read of the card: a merge moves the card to merged from every state but closed, which close refuses as card_closed', async () => {
    const before: Record<string, (made: CloseBench, cardId: number) => void> = {
      'no admitted body': () => {},
      'an admitted body': admittedBody,
      'dropped before a merge by hand': (made, cardId) => {
        admittedBody(made, cardId)
        appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_MOVED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_MOVED}:${cardId}`, payload: { lane: DROPPED_LANE }, legacy: false })
      },
    }
    for (const [setting, setUp] of Object.entries(before)) {
      const made = bench()
      setUp(made, 1090)
      opened(made, 990)
      verified(made, 990)
      merged(made, 990)

      expect(cardStateOf(made, 1090), setting).toBe('merged')
      const node = nodeOf(made, { mode: 'live' })
      await once(node)
      made.tick()
      await once(node)
      expect(eventsOf(made.db, CARD_CLOSED), setting).toEqual([{ verification: 'run' }])
      expect(cardStateOf(made, 1090), setting).toBe('closed')
    }
  })

  it('a queued review task of an old head is superseded by deriveQueues beside the close node as before', async () => {
    const made = bench()
    const node = nodeOf(made)
    await once(node)

    opened(made, 980)
    detectReview(made)
    expect(taskStatesOf(made, 'review', 980)).toEqual([{ head: sha('a'), state: 'queued' }])
    made.gitHub.pulls.get(980)!.head = sha('b')
    made.tick()
    detectReview(made)
    await once(node)

    expect(taskStatesOf(made, 'review', 980)).toEqual([{ head: sha('a'), state: 'superseded' }, { head: sha('b'), state: 'queued' }])
    expect(eventsOf(made.db, NODE_DETECTED).filter(detected => !String(detected.key).startsWith('review:'))).toEqual([])
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

  it('a running probe card verified by a report is closed by the node, and an implement card verified without a merged pull request is not', async () => {
    const made = bench()
    const ts = made.clock.now().toISOString()
    appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'reducer', cardId: 1200, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:1200`, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:earlier', cardId: 1200, pr: null, head: null, dedupeKey: `${CARD_STARTED}:1200`, payload: { session: 's' }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_VERIFIED, actor: 'worker:task-close:window', cardId: 1200, pr: null, head: null, dedupeKey: `${CARD_VERIFIED}:1200`, payload: { path: 'cheap', verification: 'run', report: '/shift/report-1200.md' }, legacy: false })
    opened(made, 990)
    verified(made, 990)
    made.tick()

    await once(nodeOf(made, { mode: 'live' }))
    made.tick()

    const closedCards = made.db.prepare('SELECT card_id FROM events WHERE type = ? ORDER BY id').all(CARD_CLOSED).map(row => Number(row.card_id))
    expect(closedCards).toEqual([1200])
    expect(eventsOf(made.db, CARD_CLOSED)).toEqual([{ verification: 'run', report: '/shift/report-1200.md' }])
    expect(made.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(1200)).toEqual({ state: 'closed' })
    expect(made.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(1090)).not.toEqual({ state: 'closed' })
  })

  it('a probe whose report close carries no verification word is denied and closes nothing', async () => {
    const made = bench()
    probeVerified(made, 1210, { path: 'cheap', report: '/shift/report-1210.md' })
    probeVerified(made, 1211, { path: 'cheap', verification: 'tests', report: '/shift/report-1211.md' })

    const node = nodeOf(made, { mode: 'live' })
    await once(node)
    await once(node)

    expect(eventsOf(made.db, CARD_CLOSED)).toEqual([])
    expect(eventsOf(made.db, POLICY_DENIED)).toMatchObject([{ command: 'close', reason: 'no_verification' }, { command: 'close', reason: 'no_verification' }])
  })

  it('a probe closed before its close was recorded is denied as card_closed and withdrawn', () => {
    const made = bench()
    const ts = made.clock.now().toISOString()
    probeVerified(made, 1220, { path: 'cheap', verification: 'run', report: '/shift/report-1220.md' })
    queueTask(made.db, ts, { queue: 'close', cardId: 1220 })
    const lease = leaseNext(made.db, ts, 'close', 'worker:close:node-1')!
    closedEarlier(made, 1220)

    const outcome = new CloseExecutor({ db: made.db, reported: () => 'run', clock: made.clock.now, journal: path.join(made.root, 'ghosts.jsonl'), parking: path.join(made.root, 'parking'), trees: { remove: () => null } }).close(lease)

    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'card_closed' }, next: 'withdrawn' })
    expect(eventsOf(made.db, CARD_CLOSED)).toHaveLength(1)
  })

  it('close skips a candidate cardContract reads as not mine', async () => {
    const made = bench()
    admittedBody(made, 1240)
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_MOVED, actor: 'worker:intake:by-hand', cardId: 1240, pr: null, head: null, dedupeKey: `${CARD_MOVED}:1240`, payload: { lane: DROPPED_LANE }, legacy: false })
    probeVerified(made, 1240, { path: 'cheap', verification: 'run', report: '/shift/report-1240.md' })
    made.tick()
    expect(cardStateOf(made, 1240)).toBe('dropped')

    const node = nodeOf(made, { mode: 'live' })
    await once(node)
    await once(node)

    expect(eventsOf(made.db, CARD_CLOSED)).toEqual([])
    expect(cardStateOf(made, 1240)).toBe('dropped')
    expect(eventsOf(made.db, POLICY_DENIED)).toEqual([expect.objectContaining({ command: 'close', kind: 'technical', reason: 'not_mine', detail: expect.stringContaining('is dropped in the bus') })])
    expect(made.db.prepare(`SELECT state FROM tasks WHERE queue = 'close' AND card_id = ?`).all(1240)).toEqual([{ state: 'withdrawn' }])
  })

  it('a probe close removes the card session tree like a pull request close does', async () => {
    const made = bench()
    const worktree = '/trees/mc-1230'
    const removed: string[] = []
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId: 1230, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-1230`, payload: { session: 's', worktree, branch: 'feat/card-1230', base: 'f'.repeat(40), pid: 1, pgid: 1 }, legacy: false })
    probeVerified(made, 1230, { path: 'cheap', verification: 'run', report: '/shift/report-1230.md' })

    await once(nodeOf(made, { mode: 'live', trees: { remove: (tree) => {
      removed.push(tree)
      return { path: tree, dirty: 0, kept: false }
    } } }))

    expect(eventsOf(made.db, CARD_CLOSED)).toEqual([{ verification: 'run', report: '/shift/report-1230.md' }])
    expect(removed).toEqual([worktree])
    expect(eventsOf(made.db, ARTIFACT_REMOVED)).toMatchObject([{ path: worktree, dirty: 0 }])
  })
})

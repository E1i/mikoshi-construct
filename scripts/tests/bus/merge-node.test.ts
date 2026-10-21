import type { CheckTest } from '../../bus/check-catalog.js'
import type { MergeNodeParts } from '../../bus/merge-worker.js'
import type { DetectionMode, Scope } from '../../bus/node.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { DROPPED_LANE } from '../../bus/card-automaton.js'
import { RERUN_VARIABLE, writeCatalog } from '../../bus/check-catalog.js'
import { appendEvent } from '../../bus/db.js'
import { recordDecision } from '../../bus/decisions.js'
import { completeTask, leaseNext } from '../../bus/lease.js'
import { MergeExecutor } from '../../bus/merge-executor.js'
import { MergeNode } from '../../bus/merge-worker.js'
import { NODE_CURSORS } from '../../bus/node.js'
import { keyOf, MERGE_CANDIDATES, mergeCandidates, NEEDS_UPDATE, queueTask } from '../../bus/queue.js'
import { UpdateNode } from '../../bus/update-worker.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_MOVED, COMMAND_EXECUTED, MERGE_DONE, NODE_DETECTED, NODE_EQUIVALENCE, POLICY_ALLOWED, POLICY_DENIED, REVIEW_RECORDED, TASK_ENQUEUED } from '../../core/events.js'
import { cardBody, MAIN_2, REPO, sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench, spendReviewRounds, taskState } from './merge-bench.js'
import { detectMerge } from './merge-detection.js'

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

function nodeOf(made: MergeBench, mode: DetectionMode = 'shadow', env: NodeJS.ProcessEnv = {}): ProbedMergeNode {
  const parts: MergeNodeParts = { db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, session: 'node-1', run: null, mode, env }
  return new ProbedMergeNode(parts)
}

function updateNodeOf(made: MergeBench, env: NodeJS.ProcessEnv): UpdateNode {
  return new UpdateNode({ db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, settle: () => {}, session: 'node-2', mode: 'live', env })
}

const BY_LAYERS = { [RERUN_VARIABLE]: 'by-layers' }
const MERGE_PUT = `${REPO}/pulls/970/merge`

function catalogTest(test: string, layer: string): CheckTest {
  return { test, layer, kind: 'unit', what: '', witness: '' }
}

const CATALOG = [catalogTest('scripts/tests/bus/merge-node.test.ts', 'bus-core,bus:merge'), catalogTest('tests/cli.test.ts', 'src')]

interface Moved {
  mainFiles: string[]
  mergeable?: string
  upToDateRequired?: boolean
  prFiles?: string[]
  prRenamedFrom?: Record<string, string>
  mainRenamedFrom?: Record<string, string>
  commitsBeyondTheCompare?: number
}

const PR_FILES = ['scripts/bus/merge-worker.ts', 'scripts/tests/bus/merge-node.test.ts', '.changeset/merge-rerun.md']

const A_MATRIX_COUNT_LINE = '■ 4 □ 1 · 1'

function mainMovedUnder(made: MergeBench, moved: Moved): void {
  writeCatalog(made.db, { tests: CATALOG, mutations: [] })
  made.gitHub.upToDateRequired = moved.upToDateRequired ?? false
  made.gitHub.main = MAIN_2
  made.gitHub.mainFiles = { [MAIN_2]: moved.mainFiles }
  made.gitHub.mainRenamedFrom = moved.mainRenamedFrom ?? {}
  made.gitHub.commitsBeyondTheCompare = moved.commitsBeyondTheCompare ?? 0
  made.gitHub.open({ number: 970, review: 'success', mergeable_state: moved.mergeable ?? 'behind', files: moved.prFiles ?? PR_FILES, renamedFrom: moved.prRenamedFrom, body: `${cardBody(970)}\n\n${A_MATRIX_COUNT_LINE}` })
  made.tick()
}

async function mergeAndUpdate(made: MergeBench, env: NodeJS.ProcessEnv): Promise<string[]> {
  const merge = nodeOf(made, 'live', env)
  const update = updateNodeOf(made, env)
  for (let round = 0; round < 2; round += 1) {
    await once(merge)
    await once(update)
    made.tick()
  }
  return made.gitHub.puts.map(each => `${each.endpoint === MERGE_PUT ? 'merge' : 'update'} ${each.fields.sha ?? each.fields.expected_head_sha}`)
}

const UPDATED_THE_LEASED_HEAD = `update ${sha('a')}`
const MERGED_THE_LEASED_HEAD = `merge ${sha('a')}`
const MERGED_THE_UPDATED_HEAD = `merge ${sha('d')}`

async function once(node: MergeNode | UpdateNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function lawOf(made: MergeBench): Record<string, unknown>[] {
  return made.db.prepare(`SELECT type, payload FROM events WHERE type IN (?, ?, ?) ORDER BY id`).all(POLICY_ALLOWED, COMMAND_EXECUTED, MERGE_DONE).map(row => ({ type: row.type, ...(JSON.parse(String(row.payload)) as Record<string, unknown>) }))
}

function executorOf(made: MergeBench, parts: Partial<ConstructorParameters<typeof MergeExecutor>[0]>): MergeExecutor {
  return new MergeExecutor({ db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, run: null, ...parts })
}

function ownerDecided(made: MergeBench, pr: number): void {
  made.gitHub.open({ number: pr, review: 'failure', mergeable_state: 'blocked', blockedBy: 'review' })
  spendReviewRounds(made, pr, sha('a'))
  recordDecision(made.db, { ts: made.clock.now().toISOString(), decisionId: 120, text: `[owner] allow-merge PR #${pr} at ${sha('a')} past the round limit`, cards: [] })
  made.tick()
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

function admitted(made: MergeBench, cardId: number, text = `card: #${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nMerge it.\n`): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${cardId}`, payload: { card: `#${cardId}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
}

function dropped(made: MergeBench, cardId: number): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_MOVED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_MOVED}:${cardId}`, payload: { lane: DROPPED_LANE }, legacy: false })
}

function closedAfterAnEarlierMerge(made: MergeBench, cardId: number): void {
  mergeDone(made, cardId, 971)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:worker-0', cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { verification: 'run' }, legacy: false })
}

const NOT_MINE: Record<string, (made: MergeBench, cardId: number) => void> = { dropped, closed: closedAfterAnEarlierMerge }

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
  it('finds what mergeCandidates finds: a green pass on a clean head, scoped by pull request and card', () => {
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

  it('merge skips a candidate cardContract reads as not mine', async () => {
    for (const [state, endedInTheBus] of Object.entries(NOT_MINE)) {
      const made = bench()
      admitted(made, 1070)
      made.gitHub.open({ number: 970, review: 'success' })
      made.tick()
      endedInTheBus(made, 1070)
      made.tick()
      const node = nodeOf(made, 'live')
      const asked = made.gitHub.calls.length
      await once(node)
      await once(node)

      expect(made.gitHub.calls.slice(asked), state).toEqual([])
      expect(made.gitHub.puts, state).toEqual([])
      expect(eventsOf(made.db, MERGE_DONE).filter(each => each.commit !== sha('f')), state).toEqual([])
      expect(eventsOf(made.db, POLICY_DENIED), state).toEqual([expect.objectContaining({ command: 'merge', kind: 'technical', reason: 'not_mine', detail: expect.stringContaining(`is ${state} in the bus`) })])
      expect(taskState(made.db, mergeKey(970)).state, state).toBe('withdrawn')
    }
  })

  it('merge takes a candidate whose card has no admitted body, or a body the parser refuses, as it did before the card was read', async () => {
    const bodies: Record<string, (made: MergeBench) => void> = {
      'no body': () => {},
      'a refused body': made => admitted(made, 1070, 'not a card\n'),
    }
    for (const [body, admit] of Object.entries(bodies)) {
      const made = bench()
      admit(made)
      made.gitHub.open({ number: 970, review: 'success' })
      made.tick()
      const node = nodeOf(made, 'live')
      await once(node)
      await once(node)

      expect(eventsOf(made.db, POLICY_DENIED), body).toEqual([])
      expect(eventsOf(made.db, MERGE_DONE), body).toEqual([expect.objectContaining({ rule: 'auto' })])
    }
  })

  it('merge takes a candidate cardContract reads as its own', async () => {
    const made = bench()
    admitted(made, 1070)
    made.gitHub.open({ number: 970, review: 'success' })
    made.tick()
    const node = nodeOf(made, 'live')
    await once(node)
    await once(node)

    expect(eventsOf(made.db, POLICY_DENIED)).toEqual([])
    expect(eventsOf(made.db, MERGE_DONE)).toEqual([expect.objectContaining({ rule: 'auto' })])
    expect(made.gitHub.puts.map(each => each.endpoint)).toEqual(['repos/{owner}/{repo}/pulls/970/merge'])
  })

  it('merge.done follows a policy.allowed with the same task_key and lease_gen', async () => {
    const made = bench()
    made.gitHub.open({ number: 970, review: 'success' })
    made.tick()
    const node = nodeOf(made, 'live')
    await once(node)
    await once(node)

    const lease = { task_key: mergeKey(970), lease_gen: 1 }
    expect(lawOf(made)).toEqual([
      { type: POLICY_ALLOWED, command: 'merge', rule: 'auto', ...lease },
      { type: COMMAND_EXECUTED, command: 'merge', ok: true, status: 200, ...lease },
      { type: MERGE_DONE, commit: expect.any(String) as unknown, rule: 'auto', ...lease },
    ])
    expect(made.gitHub.puts.map(each => each.endpoint)).toEqual([MERGE_PUT])
  })

  it('a merge GitHub refuses with 409 is followed by command.executed ok false with its status', () => {
    const made = liveBench()
    benches.push(made)
    made.gitHub.open({ number: 960, review: 'success' })
    made.tick()
    made.gitHub.mergeStatus = 409
    expect(made.merge(made.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'stale_head' } })
    const lease = { task_key: mergeKey(960), lease_gen: 1 }
    expect(lawOf(made)).toEqual([
      { type: POLICY_ALLOWED, command: 'merge', rule: 'auto', ...lease },
      { type: COMMAND_EXECUTED, command: 'merge', ok: false, status: 409, ...lease },
    ])
  })

  it('a merge put that throws is followed by command.executed ok false with the error', () => {
    const made = liveBench()
    benches.push(made)
    made.gitHub.open({ number: 960, review: 'success' })
    made.tick()
    const executor = executorOf(made, { put: () => {
      throw new Error('gh api: connection reset')
    } })
    expect(executor.merge(made.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'github_error' } })
    expect(lawOf(made)).toEqual([
      { type: POLICY_ALLOWED, command: 'merge', rule: 'auto', task_key: mergeKey(960), lease_gen: 1 },
      { type: COMMAND_EXECUTED, command: 'merge', ok: false, error: 'gh api: connection reset', task_key: mergeKey(960), lease_gen: 1 },
    ])
  })

  it('the status an owner decision publishes is followed by command.executed, ok true before the merge and ok false when it throws', () => {
    const published = liveBench()
    benches.push(published)
    ownerDecided(published, 990)
    expect(published.merge(published.lease()!)).toMatchObject({ kind: 'merged', rule: 'owner_after_round_limit' })
    const lease = { task_key: mergeKey(990), lease_gen: 1 }
    expect(lawOf(published).map(({ type, command, ok }) => [type, command, ok])).toEqual([[POLICY_ALLOWED, 'merge', undefined], [COMMAND_EXECUTED, 'publish', true], [COMMAND_EXECUTED, 'merge', true], [MERGE_DONE, undefined, undefined]])

    const refused = liveBench()
    benches.push(refused)
    ownerDecided(refused, 990)
    const executor = executorOf(refused, { publish: () => {
      throw new Error('gh api: HTTP 502')
    } })
    expect(executor.merge(refused.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'github_error' } })
    expect(lawOf(refused)).toEqual([
      { type: POLICY_ALLOWED, command: 'merge', rule: 'owner_after_round_limit', ...lease },
      { type: COMMAND_EXECUTED, command: 'publish', ok: false, error: 'gh api: HTTP 502', ...lease },
    ])
    expect(refused.gitHub.puts).toEqual([])
  })

  it('policy.allowed is written just before the first write, or before the merge.done of a pull request already merged, and not for a merge the version lock stops', () => {
    const merged = liveBench()
    benches.push(merged)
    merged.gitHub.open({ number: 972, review: 'success' })
    merged.tick()
    const lease = merged.lease()!
    merged.gitHub.close(972, true)
    expect(merged.merge(lease)).toMatchObject({ kind: 'merged' })
    expect(lawOf(merged).map(each => each.type)).toEqual([POLICY_ALLOWED, MERGE_DONE])

    const locked = liveBench()
    benches.push(locked)
    locked.gitHub.open({ number: 980, review: 'success' })
    locked.gitHub.open({ number: 981, head: sha('c'), ref: 'changeset-release/main', runs: [{ status: 'completed', conclusion: 'success' }] })
    locked.tick()
    expect(locked.merge(locked.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'version_pr_open' } })
    expect(lawOf(locked)).toEqual([])
  })

  it('i3: a cursor reset to 0 after the merge gives no second detection, no second task and no second merge.done', async () => {
    for (const mode of ['shadow', 'live'] as const) {
      const made = bench()
      made.gitHub.open({ number: 970, review: 'success' })
      made.tick()
      detectMerge(made)
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

describe('the re-run mode of the merge node', () => {
  it('the default mode updates and re-runs as now', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: ['src/cli.ts'] })

    expect(await mergeAndUpdate(made, {})).toEqual([UPDATED_THE_LEASED_HEAD, MERGED_THE_UPDATED_HEAD])
    expect(made.gitHub.pulls.get(970)).toEqual(expect.objectContaining({ head: sha('d'), baseSha: MAIN_2 }))
  })

  it('by layers, no overlap merges without a re-run', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: ['src/cli.ts'] })

    expect(await mergeAndUpdate(made, BY_LAYERS)).toEqual([MERGED_THE_LEASED_HEAD])
    expect(eventsOf(made.db, MERGE_DONE)).toEqual([expect.objectContaining({ rule: 'auto' })])
  })

  it('by layers, a change of main in a layer of the pull request updates it onto main and does not merge the old head', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: ['scripts/bus/db.ts'] })

    expect(await mergeAndUpdate(made, BY_LAYERS)).toEqual([UPDATED_THE_LEASED_HEAD, MERGED_THE_UPDATED_HEAD])
    expect(eventsOf(made.db, POLICY_DENIED)).toContainEqual(expect.objectContaining({ command: 'merge', reason: NEEDS_UPDATE, detail: expect.stringContaining('bus-core') }))
  })

  it('by layers, a clean pull request whose layers main changed is sent to the update node on a host that does not require an up-to-date branch', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: ['scripts/bus/db.ts'], mergeable: 'clean' })

    expect(await mergeAndUpdate(made, BY_LAYERS)).toEqual([UPDATED_THE_LEASED_HEAD, MERGED_THE_UPDATED_HEAD])
  })

  it('by layers, a host that requires an up-to-date branch keeps the update as now', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: ['src/cli.ts'], upToDateRequired: true })

    expect(await mergeAndUpdate(made, BY_LAYERS)).toEqual([UPDATED_THE_LEASED_HEAD, MERGED_THE_UPDATED_HEAD])
  })

  it('by layers, a clean pull request on a host that requires an up-to-date branch merges as now', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: ['scripts/bus/db.ts'], mergeable: 'clean', upToDateRequired: true })

    expect(await mergeAndUpdate(made, BY_LAYERS)).toEqual([MERGED_THE_LEASED_HEAD])
  })
})

describe('what by layers reads of main and of the pull request', () => {
  const UPDATED_THEN_MERGED = [`update ${sha('a')}`, `merge ${sha('d')}`]
  const SOURCE_ONLY = Array.from({ length: 300 }, (_, index) => `src/file-${index}.ts`)

  it('by layers, a compare that lists the 300 files GitHub caps it at counts as an overlap and updates', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: SOURCE_ONLY })

    expect(await mergeAndUpdate(made, BY_LAYERS)).toEqual(UPDATED_THEN_MERGED)
    expect(eventsOf(made.db, POLICY_DENIED)).toContainEqual(expect.objectContaining({ reason: NEEDS_UPDATE, detail: expect.stringContaining('300 files') }))
  })

  it('by layers, 299 files of main outside the layers of the pull request still merge without a re-run', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: SOURCE_ONLY.slice(1) })

    expect(await mergeAndUpdate(made, BY_LAYERS)).toEqual([`merge ${sha('a')}`])
  })

  it('by layers, a compare that lists fewer commits than total_commits counts as an overlap and updates', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: ['src/cli.ts'], commitsBeyondTheCompare: 1 })

    expect(await mergeAndUpdate(made, BY_LAYERS)).toEqual(UPDATED_THEN_MERGED)
    expect(eventsOf(made.db, POLICY_DENIED)).toContainEqual(expect.objectContaining({ reason: NEEDS_UPDATE, detail: expect.stringContaining('1 of 2 commits') }))
  })

  it('by layers, a file main renamed out of a layer of the pull request counts that layer', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: ['src/db.ts'], mainRenamedFrom: { 'src/db.ts': 'scripts/bus/db.ts' } })

    expect(await mergeAndUpdate(made, BY_LAYERS)).toEqual(UPDATED_THEN_MERGED)
    expect(eventsOf(made.db, POLICY_DENIED)).toContainEqual(expect.objectContaining({ reason: NEEDS_UPDATE, detail: expect.stringContaining('bus-core') }))
  })

  it('by layers, a file the pull request renamed out of a layer main changed counts that layer', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: ['scripts/bus/reducer.ts'], prFiles: ['src/db.ts'], prRenamedFrom: { 'src/db.ts': 'scripts/bus/db.ts' } })

    expect(await mergeAndUpdate(made, BY_LAYERS)).toEqual(UPDATED_THEN_MERGED)
    expect(eventsOf(made.db, POLICY_DENIED)).toContainEqual(expect.objectContaining({ reason: NEEDS_UPDATE, detail: expect.stringContaining('bus-core') }))
  })

  it('by layers, the same pull request without the rename merges without a re-run', async () => {
    const made = bench()
    mainMovedUnder(made, { mainFiles: ['scripts/bus/reducer.ts'], prFiles: ['src/db.ts'] })

    expect(await mergeAndUpdate(made, BY_LAYERS)).toEqual([`merge ${sha('a')}`])
  })
})

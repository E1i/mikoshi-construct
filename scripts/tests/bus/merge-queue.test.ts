import type { MergeWorkerParts } from '../../bus/merge-worker.js'
import type { DetectionMode, NodeStep } from '../../bus/node.js'
import type { UpdateOutcome } from '../../bus/update-executor.js'
import type { ShardDeps } from '../../shift/shard.js'
import type { FakePull } from './github-fake.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../bus/db.js'
import { decisionsIntake } from '../../bus/decisions-import.js'
import { recordDecision } from '../../bus/decisions.js'
import { taskKey } from '../../bus/identifiers.js'
import { ownerInbox } from '../../bus/inbox.js'
import { failTask, leaseNext, leaseQueued } from '../../bus/lease.js'
import { firstLiveVerdict, MergeNode, NoLiveVerdict, runMergeWorker } from '../../bus/merge-worker.js'
import { FAILURES_TO_STOP, queueTask } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { DRY_RUN_ACTOR } from '../../bus/review-worker.js'
import { activeWindowShards, decisionsInForceAt, unspentShard } from '../../bus/shards.js'
import { UpdateExecutor } from '../../bus/update-executor.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_STOPPED, MERGE_DONE, POLICY_DENIED, REVIEW_RECORDED, SHARD_EXPIRED, SHARD_ISSUED, SHARD_USED } from '../../core/events.js'
import { runShard } from '../../shift/shard.js'
import { cardBody, sha } from './github-fake.js'
import { eventCount, eventsOf, liveBench, mergeBench, spendReviewRounds, taskState } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const UNTIL_MS = Date.parse('2026-10-09T13:00:00.000Z')
const D82 = '# Owner decisions\n\n- D-82 · 2026-10-09 ~11:00Z — Delegation: where the bus refuses on authority, the bus executor merges under a Shard --under this decision. until 2026-10-09T13:00Z\n'
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function delegatedBench(decisions = D82): MergeBench & { file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-merge-delegation-'))
  roots.push(root)
  const file = path.join(root, 'owner-decisions.md')
  writeFileSync(file, decisions)
  writeFileSync(path.join(root, 'owner-decisions.archive.md'), `# Owner decisions archive\n\n${Array.from({ length: 81 }, (_, index) => `- D-${index + 1} · 2026-10-08 — archived ${index + 1}.\n`).join('')}`)
  return { ...liveBench((db, clock) => decisionsIntake(db, file, clock.now)), file }
}

function shardDeps(bench: MergeBench, id: string, out: string[] = []): ShardDeps {
  return {
    cwd: path.dirname(bench.busPath),
    handoffDir: path.dirname(bench.busPath),
    append: (file, text) => writeFileSync(file, text, { flag: 'a' }),
    record: event => appendEvent(bench.db, event),
    activeWindows: now => activeWindowShards(bench.db, now),
    inForce: (decisionId, now) => decisionsInForceAt(bench.db, now).some(decision => decision.decisionId === decisionId),
    now: bench.clock.now,
    uuid: () => id,
    by: () => '',
    out: line => out.push(line),
    err: line => out.push(line),
  }
}

function shardUnderD82(bench: MergeBench, pr: number): number {
  return runShard(['--pr', String(pr), '--under', 'D-82', '--by', 'Eli'], shardDeps(bench, `shard-${pr}`))
}

function mergeTaskState(bench: MergeBench, pr: number): string {
  return (bench.db.prepare(`SELECT state FROM tasks WHERE queue = 'merge' AND pr = ?`).get(pr) as { state: string }).state
}

function ownerPulls(bench: MergeBench, pulls: (Partial<FakePull> & { number: number })[]): void {
  for (const pull of pulls)
    bench.gitHub.open({ review: 'success', body: cardBody(pull.number, 'owner'), ...pull })
}

function recorded(bench: MergeBench, actor: string): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor, cardId: 1070, pr: 970, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:${actor}`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
}

function parts(bench: MergeBench): MergeWorkerParts {
  return { db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, session: 'worker-1', run: null }
}

function mergeNode(bench: MergeBench, mode: DetectionMode = 'shadow'): MergeNode {
  return new MergeNode({ ...parts(bench), mode, env: {} })
}

async function step(node: MergeNode): Promise<NodeStep | null> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  return node.getState().lastStep
}

const ROUND_LIMITED_PR = 970
const DECIDED_HEAD = sha('a')
const UPDATED_HEAD = sha('d')

function decidedAndBehind(): MergeBench & { update: () => UpdateOutcome } {
  const bench = liveBench()
  bench.gitHub.open({ number: ROUND_LIMITED_PR, head: DECIDED_HEAD, review: 'failure', mergeable_state: 'behind', files: ['scripts/bus/queue.ts'] })
  spendReviewRounds(bench, ROUND_LIMITED_PR, DECIDED_HEAD)
  recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: 168, text: `[owner] allow-merge PR #${ROUND_LIMITED_PR} at ${DECIDED_HEAD} past the round limit`, cards: [] })
  bench.tick()
  detectUpdate(bench)
  const executor = new UpdateExecutor({ db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {} })
  return { ...bench, update: () => executor.update(leaseNext(bench.db, bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')!) }
}

describe('an allow-merge across an update-branch', () => {
  it('an update-branch after an allow-merge is merged by the bus without a new decision', () => {
    const bench = decidedAndBehind()
    expect(bench.update()).toMatchObject({ kind: 'updated', from: DECIDED_HEAD, to: UPDATED_HEAD, carry: { clean: true } })
    bench.tick()
    const lease = bench.lease()

    expect(lease).toMatchObject({ queue: 'merge', head: UPDATED_HEAD })
    expect(bench.merge(lease!)).toMatchObject({ kind: 'merged', rule: 'owner_after_round_limit' })
    expect(bench.gitHub.puts.filter(put => put.endpoint.endsWith('/merge')).map(put => put.fields.sha)).toEqual([UPDATED_HEAD])
    bench.close()
  })

  it('a new commit that changes code voids the allow-merge', () => {
    const changedByTheUpdate = decidedAndBehind()
    changedByTheUpdate.gitHub.updatedPatches = { 'scripts/bus/queue.ts': '@@ -1,2 +1,2 @@ a line main also changed' }
    expect(changedByTheUpdate.update()).toMatchObject({ kind: 'updated', to: UPDATED_HEAD, carry: { clean: false } })
    changedByTheUpdate.tick()
    expect(changedByTheUpdate.lease()).toBeNull()
    changedByTheUpdate.close()

    const pushed = decidedAndBehind()
    pushed.gitHub.open({ number: ROUND_LIMITED_PR, head: sha('e'), review: 'failure', files: ['scripts/bus/queue.ts'] })
    pushed.tick()
    expect(pushed.lease()).toBeNull()
    pushed.close()
  })
})

describe('the merge worker', () => {
  it('the merge worker refuses to switch on before the first live review verdict', async () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 970, review: 'success' })
    bench.tick()
    await expect(step(mergeNode(bench))).rejects.toThrow(NoLiveVerdict)

    recorded(bench, 'owner')
    recorded(bench, DRY_RUN_ACTOR)
    expect(firstLiveVerdict(bench.db)).toBeNull()
    const before = eventCount(bench.db)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runMergeWorker(['--on'], { busPath: bench.busPath, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, session: 'worker-1', pause: async () => {} })).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('refused to switch on'))
    expect(eventCount(bench.db)).toBe(before)
    expect(bench.gitHub.puts).toEqual([])

    recorded(bench, 'worker:review:reviewer-1')
    const worker = mergeNode(bench)
    expect(await step(worker)).toMatchObject({ kind: 'merged' })
    expect(await step(worker)).toEqual({ kind: 'idle' })
    bench.close()
  })

  it('an owner pull request under an issued shard goes from pass to merge.done with rule owner_under_shard and no owner step', async () => {
    const bench = liveBench()
    recorded(bench, 'worker:review:reviewer-1')
    bench.gitHub.open({ number: 726, review: 'success', body: cardBody(726, 'owner') })
    bench.gitHub.open({ number: 727, review: 'success', body: cardBody(727, 'owner') })
    const out: string[] = []
    expect(runShard(['--card', '826', '--by', 'Eli'], shardDeps(bench, 'shard-826', out))).toBe(0)
    bench.tick()

    const worker = mergeNode(bench)
    const steps = [await step(worker), await step(worker)]
    expect(steps).toMatchObject([{ kind: 'merged', rule: 'owner_under_shard' }, { kind: 'denied', denial: { kind: 'authority', rule: 'owner_without_shard' } }])
    expect(eventsOf(bench.db, MERGE_DONE)).toEqual([{ commit: expect.any(String) as unknown, rule: 'owner_under_shard' }])
    expect(eventsOf(bench.db, SHARD_USED)).toEqual([{ id: 'shard-826', commit: expect.any(String) as unknown }])
    expect(bench.gitHub.puts).toHaveLength(1)
    expect(ownerInbox(bench.db).map(line => line.pr)).toEqual([727])
    expect(bench.db.prepare(`SELECT type FROM events WHERE actor = 'owner' AND type != ? ORDER BY id`).all(REVIEW_RECORDED).map(row => row.type)).toEqual([SHARD_ISSUED])
    bench.close()
  })

  it('a spent shard covers no second owner pull request of its card', async () => {
    const bench = liveBench()
    recorded(bench, 'worker:review:reviewer-1')
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: 726, head: null, dedupeKey: `${SHARD_ISSUED}:shard-726`, payload: { id: 'shard-726', by: 'Eli', run: null }, legacy: false })
    bench.gitHub.open({ number: 726, review: 'success', body: cardBody(726, 'owner') })
    bench.tick()
    const worker = mergeNode(bench)
    expect(await step(worker)).toMatchObject({ kind: 'merged', rule: 'owner_under_shard' })
    expect(unspentShard(bench.db, 826, 726)).toBeNull()
    bench.close()
  })

  it('an auto pull request of a card that holds a shard merges under auto and leaves the shard unspent', async () => {
    const bench = liveBench()
    recorded(bench, 'worker:review:reviewer-1')
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: 826, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:shard-826`, payload: { id: 'shard-826', by: 'Eli', run: null }, legacy: false })
    bench.gitHub.open({ number: 726, review: 'success', body: cardBody(726, 'auto') })
    bench.tick()
    const worker = mergeNode(bench)
    expect(await step(worker)).toMatchObject({ kind: 'merged', rule: 'auto' })
    expect(eventsOf(bench.db, SHARD_USED)).toEqual([])
    expect(unspentShard(bench.db, 826, null)?.id).toBe('shard-826')
    bench.close()
  })

  it('a merge step writes shard.expired for a window shard past its term', async () => {
    const bench = liveBench()
    recorded(bench, 'worker:review:reviewer-1')
    expect(runShard(['--window', '--hours', '1', '--by', 'Eli'], shardDeps(bench, 'shard-window'))).toBe(0)
    bench.clock.advance(60 * 60_000)
    bench.gitHub.open({ number: 726, review: 'success', body: cardBody(726, 'auto') })
    bench.tick()
    expect(await step(mergeNode(bench))).toMatchObject({ kind: 'merged', rule: 'auto' })
    expect(eventsOf(bench.db, SHARD_EXPIRED)).toEqual([{ id: 'shard-window' }])
    bench.close()
  })

  it('under a 6 h merge shard the bus merges an R1 owner PR', async () => {
    const bench = liveBench()
    recorded(bench, 'worker:review:reviewer-1')
    ownerPulls(bench, [{ number: 726, files: ['scripts/bus/queue.ts'] }])
    bench.tick()
    const worker = mergeNode(bench)
    expect(await step(worker)).toMatchObject({ kind: 'denied', denial: { kind: 'authority' }, next: 'withdrawn' })

    expect(runShard(['--window', '--by', 'Eli'], shardDeps(bench, 'shard-window'))).toBe(0)
    bench.clock.advance(5 * 60 * 60_000)
    bench.tick()
    expect(await step(worker)).toMatchObject({ kind: 'merged', rule: 'owner_under_shard' })
    expect(eventsOf(bench.db, MERGE_DONE)).toEqual([{ commit: expect.any(String) as unknown, rule: 'owner_under_shard' }])
    expect(eventsOf(bench.db, SHARD_USED)).toEqual([])
    expect(activeWindowShards(bench.db, bench.clock.now()).map(shard => shard.id)).toEqual(['shard-window'])
    bench.close()
  })

  it('after the shard term an R1 owner PR waits for the owner again', async () => {
    const bench = liveBench()
    recorded(bench, 'worker:review:reviewer-1')
    expect(runShard(['--window', '--by', 'Eli'], shardDeps(bench, 'shard-window'))).toBe(0)
    ownerPulls(bench, [{ number: 725, files: ['scripts/bus/queue.ts'] }])
    bench.tick()
    const worker = mergeNode(bench)
    expect(await step(worker)).toMatchObject({ kind: 'merged', rule: 'owner_under_shard' })

    bench.clock.advance(6 * 60 * 60_000)
    ownerPulls(bench, [{ number: 726, files: ['scripts/bus/queue.ts'] }])
    bench.tick()
    expect(await step(worker)).toMatchObject({ kind: 'denied', denial: { kind: 'authority' }, next: 'withdrawn' })
    expect(bench.gitHub.puts).toHaveLength(1)
    expect(ownerInbox(bench.db).map(line => line.pr)).toEqual([726])
    bench.close()
  })

  it('a version PR is refused under any shard', async () => {
    const bench = liveBench()
    recorded(bench, 'worker:review:reviewer-1')
    expect(runShard(['--window', '--scope', 'merge+decisions', '--by', 'Eli'], shardDeps(bench, 'shard-window'))).toBe(0)
    expect(runShard(['--pr', '726', '--by', 'Eli'], shardDeps(bench, 'shard-726'))).toBe(0)
    ownerPulls(bench, [
      { number: 725, files: ['scripts/bus/queue.ts'] },
      { number: 726, ref: 'changeset-release/main', files: ['package.json'] },
    ])
    bench.tick()
    const worker = mergeNode(bench)
    expect([await step(worker), await step(worker)]).toMatchObject([
      { kind: 'merged', rule: 'owner_under_shard' },
      { kind: 'denied', denial: { kind: 'authority', rule: 'version_pr' } },
    ])
    expect(bench.gitHub.puts.map(put => put.endpoint)).toEqual(['repos/{owner}/{repo}/pulls/725/merge'])
    bench.close()
  })

  it('before its until, a shard --under D-N lifts owner_by_risk, R1 and security-invariants and the pull request gets merge.done with rule owner_under_shard', async () => {
    const bench = delegatedBench()
    recorded(bench, 'worker:review:reviewer-1')
    ownerPulls(bench, [
      { number: 980, files: ['scripts/ghosts/approve.ts'] },
      { number: 981, files: ['architecture/security-invariants.md'] },
      { number: 982, files: ['.claude/agents/review.md'] },
    ])
    for (const pr of [980, 981, 982])
      expect(shardUnderD82(bench, pr)).toBe(0)
    bench.tick()

    const worker = mergeNode(bench)
    expect([await step(worker), await step(worker), await step(worker)]).toMatchObject([980, 981, 982].map(() => ({ kind: 'merged', rule: 'owner_under_shard' })))
    expect(eventsOf(bench.db, MERGE_DONE).map(done => done.rule)).toEqual(['owner_under_shard', 'owner_under_shard', 'owner_under_shard'])
    expect(eventsOf(bench.db, SHARD_USED).map(used => used.id)).toEqual(['shard-980', 'shard-981', 'shard-982'])
    expect(eventsOf(bench.db, POLICY_DENIED)).toEqual([])
    bench.close()
  })

  it('after its until, the same shard --under D-N gets policy.denied authority', async () => {
    const bench = delegatedBench()
    recorded(bench, 'worker:review:reviewer-1')
    ownerPulls(bench, [{ number: 980, files: ['scripts/ghosts/approve.ts'] }])
    expect(shardUnderD82(bench, 980)).toBe(0)
    bench.clock.ms = UNTIL_MS
    bench.tick()

    expect(await step(mergeNode(bench))).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'owner_by_risk' }, next: 'withdrawn' })
    expect(eventsOf(bench.db, MERGE_DONE)).toEqual([])
    expect(eventsOf(bench.db, SHARD_USED)).toEqual([])
    expect(bench.gitHub.puts).toEqual([])
    const out: string[] = []
    expect(runShard(['--pr', '980', '--under', 'D-82', '--by', 'Eli'], shardDeps(bench, 'shard-late', out))).toBe(1)
    expect(out).toEqual([expect.stringContaining('D-82 is not in force')])
    bench.close()
  })

  it('an until the decisions file cannot read leaves D-N out of force, and a shard --under it gets policy.denied authority', async () => {
    for (const unread of ['until 2026-10-09T13:00Z.', '(until 2026-10-09T13:00Z)']) {
      const bench = delegatedBench(D82.replace('until 2026-10-09T13:00Z', unread))
      recorded(bench, 'worker:review:reviewer-1')
      ownerPulls(bench, [{ number: 980, files: ['scripts/ghosts/approve.ts'] }])
      bench.tick()
      const out: string[] = []
      expect(runShard(['--pr', '980', '--under', 'D-82', '--by', 'Eli'], shardDeps(bench, 'shard-unread', out))).toBe(1)
      expect(out).toEqual([expect.stringContaining('D-82 is not in force')])
      expect(await step(mergeNode(bench))).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'owner_by_risk' } })
      expect(eventsOf(bench.db, MERGE_DONE)).toEqual([])
      bench.close()
    }
  })

  it('a corrupted until after a passed import takes the authority away: a shard --under that D-N gets policy.denied authority', async () => {
    const bench = delegatedBench()
    recorded(bench, 'worker:review:reviewer-1')
    ownerPulls(bench, [{ number: 980, files: ['scripts/ghosts/approve.ts'] }])
    bench.tick()
    expect(decisionsInForceAt(bench.db, bench.clock.now()).map(decision => decision.decisionId)).toEqual([82])
    expect(shardUnderD82(bench, 980)).toBe(0)

    writeFileSync(bench.file, D82.replace('until 2026-10-09T13:00Z', 'until 2026-10-09T13:00 Z'))
    bench.tick()
    expect(decisionsInForceAt(bench.db, bench.clock.now())).toEqual([])
    expect(await step(mergeNode(bench))).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'owner_by_risk' } })
    expect(eventsOf(bench.db, MERGE_DONE)).toEqual([])
    expect(bench.gitHub.puts).toEqual([])
    bench.close()
  })

  it('a merge under an active delegation after an authority refusal goes through the bus executor and writes merge.done', async () => {
    const bench = delegatedBench()
    recorded(bench, 'worker:review:reviewer-1')
    ownerPulls(bench, [{ number: 980, files: ['scripts/ghosts/approve.ts'] }])
    bench.tick()
    const worker = mergeNode(bench)
    expect(await step(worker)).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'owner_by_risk' }, next: 'withdrawn' })

    expect(shardUnderD82(bench, 980)).toBe(0)
    bench.tick()
    expect(await step(worker)).toMatchObject({ kind: 'merged', rule: 'owner_under_shard' })
    expect(eventsOf(bench.db, MERGE_DONE)).toEqual([{ commit: expect.any(String) as unknown, rule: 'owner_under_shard' }])
    expect(bench.gitHub.puts.map(put => put.endpoint)).toEqual(['repos/{owner}/{repo}/pulls/980/merge'])
    bench.close()
  })

  it('a merge task withdrawn on authority is requeued once by a shard naming its card or pull request, and a second authority refusal does not bring it back', async () => {
    const bench = delegatedBench()
    recorded(bench, 'worker:review:reviewer-1')
    ownerPulls(bench, [{ number: 980, files: ['scripts/ghosts/approve.ts'] }])
    bench.tick()
    const worker = mergeNode(bench)
    expect(await step(worker)).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'owner_by_risk' } })
    expect(mergeTaskState(bench, 980)).toBe('withdrawn')

    expect(runShard(['--card', '1080', '--by', 'Eli'], shardDeps(bench, 'shard-plain'))).toBe(0)
    bench.tick()
    expect(mergeTaskState(bench, 980)).toBe('queued')
    expect(await step(worker)).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'owner_by_risk' } })
    expect(mergeTaskState(bench, 980)).toBe('withdrawn')

    expect(shardUnderD82(bench, 980)).toBe(0)
    bench.tick()
    expect(mergeTaskState(bench, 980)).toBe('withdrawn')
    expect(await step(worker)).toEqual({ kind: 'idle' })
    expect(bench.gitHub.puts).toEqual([])
    bench.close()
  })

  it('a pull request whose card depends on a card with no merge.done is not a merge candidate, and becomes one after that merge.done', async () => {
    const bench = liveBench()
    const ts = bench.clock.now().toISOString()
    appendEvent(bench.db, { ts, type: CARD_ADMITTED, actor: 'reducer', cardId: 826, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:826`, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [838] }, legacy: false })
    bench.gitHub.open({ number: 726, review: 'success', body: cardBody(726, 'auto') })
    bench.tick()
    expect(bench.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'merge' AND pr = 726`).get()).toEqual({ n: 0 })

    appendEvent(bench.db, { ts, type: MERGE_DONE, actor: 'worker:merge:worker-0', cardId: 838, pr: 738, head: sha('e'), dedupeKey: `${MERGE_DONE}:738`, payload: { commit: sha('f'), rule: 'auto' }, legacy: false })
    bench.tick()
    expect(mergeTaskState(bench, 726)).toBe('queued')
    bench.close()
  })

  it('ships switched off: without --on it opens nothing and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bench = liveBench()
    expect(await runMergeWorker([], { busPath: '/nonexistent/bus.db', gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, session: 'worker-1', pause: async () => {} })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
    bench.close()
  })
})

const FOUR_QUEUES = ['review', 'merge', 'update', 'answer'] as const

function tasksOfPr(bench: MergeBench, pr: number, head = sha('a')): Record<string, string> {
  const rows = bench.db.prepare('SELECT queue, state FROM tasks WHERE pr = ? AND head = ? ORDER BY queue').all(pr, head) as { queue: string, state: string }[]
  return Object.fromEntries(rows.map(row => [row.queue, row.state]))
}

function expectNoStop(bench: MergeBench): void {
  expect(bench.db.prepare(`SELECT type FROM events WHERE type IN (?, ?)`).all(CARD_STOPPED, BOARD_ALARM)).toEqual([])
  const live = projectionDump(bench.db)
  reduce(bench.db)
  expect(projectionDump(bench.db)).toBe(live)
}

describe('a head that moves under the queues', () => {
  it('a moved head supersedes the merge lease without a stop', () => {
    const bench = liveBench()
    const heads = ['a', 'b', 'c', 'd'].map(letter => sha(letter))
    const mergeKey = (head: string): string => taskKey({ queue: 'merge', cardId: 1054, pr: 954, head })
    bench.gitHub.open({ number: 954, head: heads[0], review: 'success' })
    bench.tick()
    bench.gitHub.pulls.get(954)!.mergeable_state = 'behind'
    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', taskKey: mergeKey(heads[0]!), denial: { reason: 'not_mergeable' }, next: 'queued' })

    for (const [at, head] of heads.slice(0, -1).entries()) {
      bench.gitHub.open({ number: 954, head: heads[at + 1], review: 'success' })
      expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', taskKey: mergeKey(head), denial: { reason: 'stale_head' }, next: 'superseded' })
      bench.tick()
    }

    const merges = bench.db.prepare(`SELECT task_key, state, failures FROM tasks WHERE queue = 'merge' ORDER BY id`).all() as { task_key: string, state: string, failures: number }[]
    expect(merges).toEqual([...heads.slice(0, -1).map(head => ({ task_key: mergeKey(head), state: 'superseded', failures: 0 })), { task_key: mergeKey(heads.at(-1)!), state: 'queued', failures: 0 }])
    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'merged', taskKey: mergeKey(heads.at(-1)!) })
    expectNoStop(bench)
    bench.close()
  })

  it('a new head supersedes the old head tasks in review, merge, update and answer', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 955, review: 'failure' })
    bench.tick()
    const ts = bench.clock.now().toISOString()
    for (const queue of FOUR_QUEUES)
      queueTask(bench.db, ts, { queue, cardId: 1055, pr: 955, head: sha('a') })
    leaseNext(bench.db, ts, 'merge', 'worker:merge:worker-1')
    const update = taskKey({ queue: 'update', cardId: 1055, pr: 955, head: sha('a') })
    for (let failure = 1; failure <= FAILURES_TO_STOP; failure += 1)
      failTask(bench.db, ts, leaseQueued(bench.db, ts, update, 'worker:update:worker-1')!, { reason: 'github_error', withdraw: false })
    expect(tasksOfPr(bench, 955)).toEqual({ answer: 'queued', merge: 'leased', review: 'queued', update: 'stopped' })

    bench.gitHub.open({ number: 955, head: sha('b'), review: 'failure' })
    bench.tick()

    expect(tasksOfPr(bench, 955)).toEqual(Object.fromEntries(FOUR_QUEUES.map(queue => [queue, 'superseded'])))
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('pr.closed drops every task of its pull request', () => {
    for (const merged of [false, true]) {
      const bench = mergeBench()
      bench.gitHub.open({ number: 956, review: 'failure' })
      bench.tick()
      const ts = bench.clock.now().toISOString()
      for (const queue of ['review', 'update', 'answer'] as const)
        queueTask(bench.db, ts, { queue, cardId: 1056, pr: 956, head: sha('a') })
      leaseNext(bench.db, ts, 'answer', 'worker:answer:worker-1')

      bench.gitHub.close(956, merged)
      bench.tick()

      expect(tasksOfPr(bench, 956), `merged ${String(merged)}`).toEqual({ answer: 'withdrawn', review: 'withdrawn', update: 'withdrawn' })
      const live = projectionDump(bench.db)
      reduce(bench.db)
      expect(projectionDump(bench.db)).toBe(live)
      bench.close()
    }
  })

  it('a merged pull request keeps its merge and close tasks', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 957, review: 'success' })
    bench.tick()
    const ts = bench.clock.now().toISOString()
    queueTask(bench.db, ts, { queue: 'merge', cardId: 1057, pr: 957, head: sha('a') })
    bench.gitHub.close(957, true)
    bench.tick()
    queueTask(bench.db, bench.clock.now().toISOString(), { queue: 'close', cardId: 1057, pr: 957, head: sha('a') })
    bench.tick()

    expect(tasksOfPr(bench, 957)).toEqual({ close: 'queued', merge: 'queued' })
    expect(taskState(bench.db, taskKey({ queue: 'merge', cardId: 1057, pr: 957, head: sha('a') })).failures).toBe(0)
    bench.close()
  })
})

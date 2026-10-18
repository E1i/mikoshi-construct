import type { MergeWorkerParts } from '../../bus/merge-worker.js'
import type { DetectionMode, NodeStep } from '../../bus/node.js'
import type { ShardDeps } from '../../shift/shard.js'
import type { FakePull } from './github-fake.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MERGE_DONE, REVIEW_RECORDED } from '../../bus/card-automaton.js'
import { appendEvent } from '../../bus/db.js'
import { decisionsIntake } from '../../bus/decisions-import.js'
import { ownerInbox, POLICY_DENIED } from '../../bus/inbox.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { firstLiveVerdict, MergeNode, NoLiveVerdict, runMergeWorker } from '../../bus/merge-worker.js'
import { DRY_RUN_ACTOR } from '../../bus/review-worker.js'
import { activeWindowShards, decisionsInForceAt, SHARD_EXPIRED, SHARD_ISSUED, SHARD_USED, unspentShard } from '../../bus/shards.js'
import { runShard } from '../../shift/shard.js'
import { cardBody, sha } from './github-fake.js'
import { eventCount, eventsOf, liveBench } from './merge-bench.js'

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

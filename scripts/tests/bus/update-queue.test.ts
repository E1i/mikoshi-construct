import type { Lease } from '../../core/lease.js'
import type { NodeStep } from '../../core/node.js'
import type { UpdateOutcome } from '../../nodes/update/update-executor.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { prBodySha, taskKey } from '../../core/identifiers.js'
import { ownerInbox } from '../../core/inbox.js'
import { expireLeases, LEASE_MS, leaseNext } from '../../core/lease.js'
import { NoLiveVerdict } from '../../nodes/merge/merge-worker.js'
import { updateCandidates } from '../../core/queue.js'
import { projectionDump, reduce } from '../../core/reducer.js'
import { cleanUpdate, HEAD_READS, UpdateExecutor } from '../../nodes/update/update-executor.js'
import { runUpdateWorker, UpdateNode } from '../../nodes/update/update-worker.js'
import { CARD_ADMITTED, POLICY_DENIED, REVIEW_RECORDED } from '../../core/events.js'
import { cardBody, MAIN_2, sha } from './github-fake.js'
import { eventCount, eventsOf, liveBench, taskState } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const NEW_HEAD = sha('d')
const update = (pr: number, head = sha('a')): string => taskKey({ queue: 'update', cardId: pr + 100, pr, head })

function updateBench() {
  const bench = liveBench()
  let settled = 0
  const settle = (): void => {
    settled += 1
  }
  const executor = new UpdateExecutor({ db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle })
  return {
    ...bench,
    settled: () => settled,
    leaseUpdate: (actor = 'worker:update:worker-1'): Lease | null => leaseNext(bench.db, bench.clock.now().toISOString(), 'update', actor),
    update: (lease: Lease): UpdateOutcome => executor.update(lease),
  }
}

function deniedByAuthority(bench: ReturnType<typeof liveBench>, pr: number): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: POLICY_DENIED, actor: 'policy', cardId: pr + 100, pr, head: sha('a'), dedupeKey: `${POLICY_DENIED}:owner-${pr}`, payload: { command: 'merge', kind: 'authority', rule: 'owner_by_risk', detail: 'stays the owner\'s' }, legacy: false })
}

function admittedWithPriority(bench: ReturnType<typeof liveBench>, cardId: number): void {
  const text = `card: #${cardId} task-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/${cardId}\ntouches: scripts/${cardId}/**\nwho: shift\npriority: p0\n\ndo ${cardId}\n`
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { text, textSha: textSha(text), lane: null, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
}

describe('the update queue', () => {
  it('a behind PR with a pass on its head enters update', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 980, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    detectUpdate(bench)

    expect(taskState(bench.db, update(980))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    expect(bench.lease()).toBeNull()
    expect(bench.leaseUpdate()).toMatchObject({ taskKey: update(980), queue: 'update', head: sha('a'), leaseGen: 1 })
    bench.close()
  })

  it('a merge of another pull request makes a pass pull request behind and queues its update within two ticks', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 970, review: 'success' })
    bench.gitHub.open({ number: 971, review: 'success' })
    bench.tick()
    expect(bench.leaseUpdate()).toBeNull()

    bench.gitHub.close(971, true)
    bench.gitHub.main = MAIN_2
    bench.gitHub.pulls.get(970)!.mergeable_state = 'behind'
    bench.tick()
    bench.tick()
    detectUpdate(bench)

    expect(taskState(bench.db, update(970))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    expect(bench.leaseUpdate()).toMatchObject({ taskKey: update(970), queue: 'update', head: sha('a') })
    bench.close()
  })

  it('a behind PR that waits for the owner without a pass does not enter update', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 981, mergeable_state: 'behind' })
    deniedByAuthority(bench, 981)
    bench.tick()
    detectUpdate(bench)

    expect(ownerInbox(bench.db)).toHaveLength(1)
    expect(bench.leaseUpdate()).toBeNull()
    bench.close()
  })

  it('of three behind PRs only the one with a pass and green CI on its old head is the update candidate', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 960, head: sha('c'), mergeable_state: 'behind' })
    bench.gitHub.open({ number: 961, head: sha('e'), review: 'success', mergeable_state: 'behind', required: 'failure' })
    bench.gitHub.open({ number: 962, head: sha('f'), review: 'success', mergeable_state: 'behind' })
    bench.tick()

    expect(updateCandidates(bench.db, bench.clock.now().toISOString())).toEqual([expect.objectContaining({ queue: 'update', cardId: 1062, pr: 962, head: sha('f') })])
    bench.close()
  })

  it('of two behind pass PRs with green CI only the older is the update candidate on a priority tie', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 964, head: sha('e'), review: 'success', mergeable_state: 'behind' })
    bench.gitHub.open({ number: 963, head: sha('f'), review: 'success', mergeable_state: 'behind' })
    bench.tick()

    expect(updateCandidates(bench.db, bench.clock.now().toISOString()).map(task => task.pr)).toEqual([963])
    bench.close()
  })

  it('of two behind pass PRs with green CI only the one of the higher card priority is the update candidate', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 965, head: sha('e'), review: 'success', mergeable_state: 'behind' })
    bench.gitHub.open({ number: 966, head: sha('f'), review: 'success', mergeable_state: 'behind' })
    admittedWithPriority(bench, 1066)
    bench.tick()

    expect(updateCandidates(bench.db, bench.clock.now().toISOString()).map(task => task.pr)).toEqual([966])
    bench.close()
  })

  it('with no behind PR that has a pass and green CI on its old head no update candidate is', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 967, head: sha('c'), mergeable_state: 'behind' })
    bench.gitHub.open({ number: 968, head: sha('e'), review: 'success', mergeable_state: 'behind', required: 'failure' })
    bench.gitHub.open({ number: 969, head: sha('f'), review: 'success', mergeable_state: 'behind', required: 'pending' })
    bench.tick()

    expect(updateCandidates(bench.db, bench.clock.now().toISOString())).toEqual([])
    bench.close()
  })

  it('a first-ranked pass PR out of review rounds with no owner decision does not hold the update slot from the next one', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 957, head: sha('e'), review: 'success', mergeable_state: 'behind' })
    bench.gitHub.open({ number: 958, head: sha('f'), review: 'success', mergeable_state: 'behind' })
    for (const round of ['1', '2', '3'])
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1057, pr: 957, head: sha(round), dedupeKey: `${REVIEW_RECORDED}:957:${round}`, payload: { head: sha(round), verdict: 'changes', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
    bench.tick()

    expect(updateCandidates(bench.db, bench.clock.now().toISOString()).map(task => task.pr)).toEqual([958])
    bench.close()
  })

  it('a PR that is not behind, has no pass and waits for no one, or is a draft, does not enter update', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 982, mergeable_state: 'behind' })
    bench.gitHub.open({ number: 983, review: 'failure', mergeable_state: 'behind' })
    bench.gitHub.open({ number: 984, review: 'success' })
    bench.gitHub.open({ number: 985, review: 'success', mergeable_state: 'behind', draft: true })
    bench.gitHub.open({ number: 986, review: 'success', mergeable_state: 'behind', base: 'develop' })
    bench.tick()
    detectUpdate(bench)

    expect(bench.leaseUpdate()).toBeNull()
    bench.close()
  })

  it('a clean update carries the verdict to the new head', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 987, review: 'success', mergeable_state: 'behind', files: ['scripts/core/queue.ts'] })
    bench.tick()
    detectUpdate(bench)

    expect(bench.update(bench.leaseUpdate()!)).toEqual({ kind: 'updated', taskKey: update(987), from: sha('a'), to: NEW_HEAD, carry: { carried: 'pass', clean: true } })
    expect(bench.gitHub.puts).toEqual([{ endpoint: 'repos/{owner}/{repo}/pulls/987/update-branch', fields: { expected_head_sha: sha('a') } }])
    expect(bench.gitHub.published).toEqual([{ commit: NEW_HEAD, state: 'success', context: 'review', description: `carried from ${sha('a')} by a clean update-branch` }])
    expect(eventsOf(bench.db, 'update.done')).toEqual([{ from: sha('a'), to: NEW_HEAD, carried: 'pass', clean: true, task_key: update(987), lease_gen: 1 }])
    expect(taskState(bench.db, update(987))).toEqual({ state: 'completed', lease_gen: 1, failures: 0 })

    bench.tick()
    expect(bench.db.prepare('SELECT head, verdict_on_head FROM prs WHERE pr = 987').get()).toEqual({ head: NEW_HEAD, verdict_on_head: 'pass' })
    expect(bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'review'`).all()).toEqual([])
    expect(bench.lease()).toMatchObject({ queue: 'merge', head: NEW_HEAD })
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('an update that changes the PR diff sends the new head back to review without a verdict', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 988, review: 'success', mergeable_state: 'behind', files: ['scripts/core/queue.ts'] })
    bench.gitHub.updatedPatches = { 'scripts/core/queue.ts': '@@ -1,2 +1,2 @@ a line main also changed' }
    bench.tick()
    detectUpdate(bench)

    const outcome = bench.update(bench.leaseUpdate()!)
    expect(outcome).toMatchObject({ kind: 'updated', to: NEW_HEAD, carry: { carried: null, why: expect.stringContaining('own diff') } })
    expect(bench.gitHub.published).toEqual([])

    bench.tick()
    expect(bench.db.prepare('SELECT verdict_on_head FROM prs WHERE pr = 988').get()).toEqual({ verdict_on_head: null })
    expect(bench.db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'review'`).all()).toEqual([{ task_key: taskKey({ queue: 'review', cardId: 1088, pr: 988, head: NEW_HEAD, input: { prBody: prBodySha(cardBody(988)), cardBody: null } }), state: 'queued' }])
    expect(bench.lease()).toBeNull()
    bench.close()
  })

  it('a new head that is not a merge of the base into the old one carries no verdict', () => {
    expect(cleanUpdate({ from: sha('a'), to: NEW_HEAD, parents: [sha('a')], before: [], after: [] })).toContain('not a merge')
    expect(cleanUpdate({ from: sha('a'), to: NEW_HEAD, parents: [sha('1'), sha('a')], before: [], after: [] })).toContain('not a merge')
    expect(cleanUpdate({ from: sha('a'), to: NEW_HEAD, parents: [sha('a'), sha('1')], before: [{ filename: 'x', status: 'added', patch: null }], after: [{ filename: 'x', status: 'added', patch: null }] })).toContain('no patch')
    expect(cleanUpdate({ from: sha('a'), to: NEW_HEAD, parents: [sha('a'), sha('1')], before: [{ filename: 'x', status: 'added', patch: '@@ x' }], after: [{ filename: 'x', status: 'added', patch: '@@ x' }] })).toBeNull()
  })

  it('a head that has not moved after every read completes the update with nothing carried', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 989, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    detectUpdate(bench)
    bench.gitHub.updatedHead = sha('a')

    expect(bench.update(bench.leaseUpdate()!)).toMatchObject({ kind: 'updated', to: null, carry: { carried: null } })
    expect(bench.settled()).toBe(HEAD_READS - 1)
    expect(bench.gitHub.published).toEqual([])
    bench.close()
  })

  it('a 422 on update-branch is a technical stale_head denial', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 990, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    detectUpdate(bench)
    bench.gitHub.updateStatus = 422

    expect(bench.update(bench.leaseUpdate()!)).toMatchObject({ kind: 'denied', taskKey: update(990), denial: { kind: 'technical', reason: 'stale_head' }, next: 'superseded' })
    expect(eventsOf(bench.db, 'policy.denied')).toMatchObject([{ command: 'update_branch', kind: 'technical', reason: 'stale_head' }])
    expect(taskState(bench.db, update(990))).toEqual({ state: 'superseded', lease_gen: 1, failures: 0 })
    expect(ownerInbox(bench.db)).toEqual([])
    expect(bench.gitHub.published).toEqual([])
    bench.close()
  })

  it('a head that moved before the update is a technical stale_head denial and sends nothing', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 991, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    detectUpdate(bench)
    const lease = bench.leaseUpdate()!
    bench.gitHub.pulls.get(991)!.head = sha('b')

    expect(bench.update(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'stale_head' }, next: 'superseded' })
    expect(bench.gitHub.puts).toEqual([])
    bench.close()
  })

  it('a pull request no longer behind is not updated', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 992, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    detectUpdate(bench)
    const lease = bench.leaseUpdate()!
    bench.gitHub.pulls.get(992)!.mergeable_state = 'dirty'

    expect(bench.update(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'not_behind' }, next: 'queued' })
    expect(bench.gitHub.puts).toEqual([])
    bench.close()
  })

  it('a mergeable state GitHub has not computed releases the task without counting a failure', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 993, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    detectUpdate(bench)
    const lease = bench.leaseUpdate()!
    bench.gitHub.pulls.get(993)!.mergeable_state = 'unknown'

    expect(bench.update(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'not_mergeable' }, next: 'queued' })
    expect(taskState(bench.db, update(993))).toEqual({ state: 'queued', lease_gen: 1, failures: 0 })
    bench.close()
  })

  it('an update command under a stale lease_gen is refused and writes nothing', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 994, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    detectUpdate(bench)
    const old = bench.leaseUpdate('worker:update:old')!
    bench.clock.advance(LEASE_MS + 1)
    expect(expireLeases(bench.db, bench.clock.now().toISOString())).toEqual([update(994)])
    const current = bench.leaseUpdate('worker:update:new')!
    expect([old.leaseGen, current.leaseGen]).toEqual([1, 2])

    const before = eventCount(bench.db)
    expect(bench.update(old)).toEqual({ kind: 'fenced', taskKey: update(994) })
    expect(eventCount(bench.db)).toBe(before)
    expect(bench.gitHub.puts).toEqual([])
    bench.close()
  })
})

async function step(node: UpdateNode): Promise<NodeStep | null> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  return node.getState().lastStep
}

describe('the update worker', () => {
  it('refuses to switch on before the first live review verdict, then takes the update queue', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const bench = updateBench()
    bench.gitHub.open({ number: 995, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    const parts = { db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {}, session: 'worker-1', mode: 'live' as const, env: {} }
    await expect(step(new UpdateNode(parts))).rejects.toThrow(NoLiveVerdict)

    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1095, pr: 995, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
    const worker = new UpdateNode(parts)
    expect(await step(worker)).toMatchObject({ kind: 'updated', taskKey: update(995), carry: { carried: 'pass' } })
    expect(await step(worker)).toEqual({ kind: 'idle' })
    bench.close()
  })

  it('ships switched off: without --on it opens nothing and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bench = updateBench()
    expect(await runUpdateWorker([], { busPath: '/nonexistent/bus.db', gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, settle: () => {}, session: 'worker-1', pause: async () => {} })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
    bench.close()
  })
})

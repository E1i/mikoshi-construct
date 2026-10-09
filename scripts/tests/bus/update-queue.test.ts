import type { Lease } from '../../bus/lease.js'
import type { UpdateOutcome } from '../../bus/update-executor.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { ownerInbox, POLICY_DENIED } from '../../bus/inbox.js'
import { expireLeases, LEASE_MS, leaseNext } from '../../bus/lease.js'
import { NoLiveVerdict } from '../../bus/merge-worker.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { REVIEW_RECORDED } from '../../bus/review-worker.js'
import { cleanUpdate, HEAD_READS, UpdateExecutor } from '../../bus/update-executor.js'
import { runUpdateWorker, startUpdateWorker } from '../../bus/update-worker.js'
import { sha } from './github-fake.js'
import { eventCount, eventsOf, mergeBench, taskState } from './merge-bench.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const NEW_HEAD = sha('d')
const update = (pr: number, head = sha('a')): string => taskKey({ queue: 'update', cardId: pr + 100, pr, head })

function updateBench() {
  const bench = mergeBench()
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

function deniedByAuthority(bench: ReturnType<typeof mergeBench>, pr: number): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: POLICY_DENIED, actor: 'policy', cardId: pr + 100, pr, head: sha('a'), dedupeKey: `${POLICY_DENIED}:owner-${pr}`, payload: { command: 'merge', kind: 'authority', rule: 'owner_by_risk', detail: 'stays the owner\'s' }, legacy: false })
}

describe('the update queue', () => {
  it('a behind PR with a pass on its head enters update', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 980, review: 'success', mergeable_state: 'behind' })
    bench.tick()

    expect(taskState(bench.db, update(980))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    expect(bench.lease()).toBeNull()
    expect(bench.leaseUpdate()).toMatchObject({ taskKey: update(980), queue: 'update', head: sha('a'), leaseGen: 1 })
    bench.close()
  })

  it('a behind PR that waits for the owner enters update without a pass', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 981, mergeable_state: 'behind' })
    deniedByAuthority(bench, 981)
    bench.tick()

    expect(ownerInbox(bench.db)).toHaveLength(1)
    expect(bench.leaseUpdate()).toMatchObject({ taskKey: update(981) })
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

    expect(bench.leaseUpdate()).toBeNull()
    bench.close()
  })

  it('a clean update carries the verdict to the new head', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 987, review: 'success', mergeable_state: 'behind', files: ['scripts/bus/queue.ts'] })
    bench.tick()

    expect(bench.update(bench.leaseUpdate()!)).toEqual({ kind: 'updated', taskKey: update(987), from: sha('a'), to: NEW_HEAD, carry: { carried: 'pass' } })
    expect(bench.gitHub.puts).toEqual([{ endpoint: 'repos/{owner}/{repo}/pulls/987/update-branch', fields: { expected_head_sha: sha('a') } }])
    expect(bench.gitHub.published).toEqual([{ commit: NEW_HEAD, state: 'success', context: 'review', description: `carried from ${sha('a')} by a clean update-branch` }])
    expect(eventsOf(bench.db, 'update.done')).toEqual([{ from: sha('a'), to: NEW_HEAD, carried: 'pass' }])
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
    bench.gitHub.open({ number: 988, review: 'success', mergeable_state: 'behind', files: ['scripts/bus/queue.ts'] })
    bench.gitHub.updatedPatches = { 'scripts/bus/queue.ts': '@@ -1,2 +1,2 @@ a line main also changed' }
    bench.tick()

    const outcome = bench.update(bench.leaseUpdate()!)
    expect(outcome).toMatchObject({ kind: 'updated', to: NEW_HEAD, carry: { carried: null, why: expect.stringContaining('own diff') } })
    expect(bench.gitHub.published).toEqual([])

    bench.tick()
    expect(bench.db.prepare('SELECT verdict_on_head FROM prs WHERE pr = 988').get()).toEqual({ verdict_on_head: null })
    expect(bench.db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'review'`).all()).toEqual([{ task_key: taskKey({ queue: 'review', cardId: 1088, pr: 988, head: NEW_HEAD }), state: 'queued' }])
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
    bench.gitHub.updateStatus = 422

    expect(bench.update(bench.leaseUpdate()!)).toMatchObject({ kind: 'denied', taskKey: update(990), denial: { kind: 'technical', reason: 'stale_head' }, next: 'queued' })
    expect(eventsOf(bench.db, 'policy.denied')).toMatchObject([{ command: 'update_branch', kind: 'technical', reason: 'stale_head' }])
    expect(taskState(bench.db, update(990))).toEqual({ state: 'queued', lease_gen: 1, failures: 1 })
    expect(ownerInbox(bench.db)).toEqual([])
    expect(bench.gitHub.published).toEqual([])
    bench.close()
  })

  it('a head that moved before the update is a technical stale_head denial and sends nothing', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 991, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    const lease = bench.leaseUpdate()!
    bench.gitHub.pulls.get(991)!.head = sha('b')

    expect(bench.update(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'stale_head' }, next: 'queued' })
    expect(bench.gitHub.puts).toEqual([])
    bench.close()
  })

  it('a pull request no longer behind is not updated', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 992, review: 'success', mergeable_state: 'behind' })
    bench.tick()
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

describe('the update worker', () => {
  it('refuses to switch on before the first live review verdict, then takes the update queue', () => {
    const bench = updateBench()
    bench.gitHub.open({ number: 995, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    const parts = { db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {}, session: 'worker-1' }
    expect(() => startUpdateWorker(parts)).toThrow(NoLiveVerdict)

    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1095, pr: 995, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:live`, payload: { head: sha('a'), verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
    const worker = startUpdateWorker(parts)
    expect(worker.step()).toMatchObject({ kind: 'updated', taskKey: update(995), carry: { carried: 'pass' } })
    expect(worker.step()).toEqual({ kind: 'idle' })
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

import { describe, expect, it } from 'vitest'
import { taskKey } from '../../bus/identifiers.js'
import { ownerInbox } from '../../bus/inbox.js'
import { assertHeld, expireLeases, LEASE_MS, StaleLease } from '../../bus/lease.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { MAIN_2, sha } from './github-fake.js'
import { eventCount, eventsOf, mergeBench, taskState } from './merge-bench.js'

const merge = (pr: number, head = sha('a')): string => taskKey({ queue: 'merge', cardId: pr + 100, pr, head })

describe('the merge executor', () => {
  it('a pass on a green, clean head is queued for merge and merged with its sha', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 960, review: 'success' })
    bench.tick()

    expect(bench.merge(bench.lease()!)).toEqual({ kind: 'merged', taskKey: merge(960), commit: MAIN_2, rule: 'auto' })
    expect(bench.gitHub.puts).toEqual([{ endpoint: 'repos/{owner}/{repo}/pulls/960/merge', fields: { sha: sha('a'), merge_method: 'squash' } }])
    expect(eventsOf(bench.db, 'merge.done')).toEqual([{ commit: MAIN_2, rule: 'auto' }])
    expect(taskState(bench.db, merge(960))).toEqual({ state: 'completed', lease_gen: 1, failures: 0 })
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('a pull request without a pass, green CI or a clean merge is not queued for merge', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 961 })
    bench.gitHub.open({ number: 962, review: 'failure' })
    bench.gitHub.open({ number: 963, review: 'success', required: 'pending' })
    bench.gitHub.open({ number: 964, review: 'success', mergeable_state: 'behind' })
    bench.gitHub.open({ number: 965, review: 'success', draft: true })
    bench.tick()

    expect(bench.lease()).toBeNull()
    bench.close()
  })

  it('a 409 on merge is a technical stale_head denial that requeues and leaves the inbox empty', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 966, review: 'success' })
    bench.tick()
    bench.gitHub.mergeStatus = 409

    const outcome = bench.merge(bench.lease()!)
    expect(outcome).toMatchObject({ kind: 'denied', taskKey: merge(966), denial: { kind: 'technical', reason: 'stale_head' }, next: 'queued' })
    expect(eventsOf(bench.db, 'policy.denied')).toMatchObject([{ command: 'merge', kind: 'technical', reason: 'stale_head' }])
    expect(taskState(bench.db, merge(966))).toEqual({ state: 'queued', lease_gen: 1, failures: 1 })
    expect(ownerInbox(bench.db)).toEqual([])

    bench.gitHub.mergeStatus = 200
    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'merged', taskKey: merge(966) })
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('a head that moved before the merge is a technical stale_head denial read from a fresh snapshot', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 967, review: 'success' })
    bench.tick()
    const lease = bench.lease()!
    bench.gitHub.pulls.get(967)!.head = sha('b')

    expect(bench.merge(lease)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'stale_head' }, next: 'queued' })
    expect(bench.gitHub.puts).toEqual([])
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('an open version pull request locks every merge and requeues without reaching the inbox', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 969, review: 'success' })
    bench.gitHub.open({ number: 970, head: sha('c'), ref: 'changeset-release/main' })
    bench.tick()

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', taskKey: merge(969), denial: { kind: 'technical', reason: 'version_pr_open' }, next: 'queued' })
    expect(bench.gitHub.puts).toEqual([])
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('the version pull request lock leaves the task queued however many ticks it lasts, and never stops the card', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 973, review: 'success' })
    bench.gitHub.open({ number: 974, head: sha('c'), ref: 'changeset-release/main' })
    bench.tick()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'version_pr_open' }, next: 'queued' })
      expect(taskState(bench.db, merge(973))).toEqual({ state: 'queued', lease_gen: attempt + 1, failures: 0 })
      bench.tick()
    }
    expect(eventsOf(bench.db, 'card.stopped')).toEqual([])
    expect(eventsOf(bench.db, 'board.alarm')).toEqual([])
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('a not_mergeable denial releases the task without counting a failure', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 975, review: 'success' })
    bench.tick()
    const lease = bench.lease()!
    bench.gitHub.pulls.get(975)!.mergeable_state = 'behind'

    expect(bench.merge(lease)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'not_mergeable' }, next: 'queued' })
    expect(taskState(bench.db, merge(975))).toEqual({ state: 'queued', lease_gen: 1, failures: 0 })
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('a red CI on the leased head is a technical ci_red denial that counts a failure, a pending one is ci_not_ready', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 978, review: 'success' })
    bench.tick()
    bench.gitHub.pulls.get(978)!.required = 'failure'

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'ci_red', detail: `CI is red on ${sha('a')}` }, next: 'queued' })
    expect(taskState(bench.db, merge(978))).toEqual({ state: 'queued', lease_gen: 1, failures: 1 })

    bench.gitHub.pulls.get(978)!.required = 'pending'
    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'ci_not_ready' }, next: 'queued' })
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('a released merge task keeps its place: the merge queue leases first in, first out by arrival', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 979, review: 'success' })
    bench.gitHub.open({ number: 980, review: 'success', head: sha('c') })
    bench.tick()
    const first = bench.lease()!
    expect(first.taskKey).toBe(merge(979))
    bench.gitHub.pulls.get(979)!.mergeable_state = 'behind'
    bench.merge(first)

    expect(bench.lease()!.taskKey).toBe(merge(979))
    bench.close()
  })

  it('a released task returns to the queue with its failure count unchanged and its lease_gen fenced', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 976, review: 'success' })
    bench.gitHub.open({ number: 977, head: sha('c'), ref: 'changeset-release/main' })
    bench.tick()
    const old = bench.lease()!
    bench.merge(old)

    expect(taskState(bench.db, merge(976))).toEqual({ state: 'queued', lease_gen: 1, failures: 0 })
    expect(() => assertHeld(bench.db, old)).toThrow(StaleLease)
    expect(bench.merge(old)).toEqual({ kind: 'fenced', taskKey: merge(976) })
    expect(bench.lease()!.leaseGen).toBe(2)
    bench.close()
  })

  it('a pull request whose base is not main is never merged', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 971, review: 'success' })
    bench.tick()
    const lease = bench.lease()!
    bench.gitHub.pulls.get(971)!.base = 'develop'

    expect(bench.merge(lease)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'wrong_base' }, next: 'queued' })
    expect(bench.gitHub.puts).toEqual([])
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('a pull request already merged at the leased head finishes as merge.done, not as stale_head', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 972, review: 'success' })
    bench.tick()
    const lease = bench.lease()!
    bench.gitHub.close(972, true)

    expect(bench.merge(lease)).toEqual({ kind: 'merged', taskKey: merge(972), commit: MAIN_2, rule: 'auto' })
    expect(bench.gitHub.puts).toEqual([])
    expect(eventsOf(bench.db, 'merge.done')).toEqual([{ commit: MAIN_2, rule: 'auto' }])
    expect(eventsOf(bench.db, 'policy.denied')).toEqual([])
    bench.close()
  })

  it('a command with a stale lease_gen is refused and writes nothing', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 968, review: 'success' })
    bench.tick()
    const old = bench.lease('worker:merge:old')!
    bench.clock.advance(LEASE_MS + 1)
    expect(expireLeases(bench.db, bench.clock.now().toISOString())).toEqual([merge(968)])
    const current = bench.lease('worker:merge:new')!
    expect([old.leaseGen, current.leaseGen]).toEqual([1, 2])

    const before = eventCount(bench.db)
    expect(bench.merge(old)).toEqual({ kind: 'fenced', taskKey: merge(968) })
    expect(eventCount(bench.db)).toBe(before)
    expect(bench.gitHub.puts).toEqual([])
    expect(taskState(bench.db, merge(968))).toEqual({ state: 'leased', lease_gen: 2, failures: 1 })
    bench.close()
  })
})

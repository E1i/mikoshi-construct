import { describe, expect, it } from 'vitest'
import { taskKey } from '../../bus/identifiers.js'
import { ownerInbox } from '../../bus/inbox.js'
import { expireLeases, LEASE_MS } from '../../bus/lease.js'
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

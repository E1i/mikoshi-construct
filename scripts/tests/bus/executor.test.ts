import type { FakeRun } from './github-fake.js'
import type { MergeBench } from './merge-bench.js'
import { describe, expect, it } from 'vitest'
import { recordDecision } from '../../bus/decisions.js'
import { taskKey } from '../../bus/identifiers.js'
import { importJournal } from '../../bus/import.js'
import { ownerInbox } from '../../bus/inbox.js'
import { assertHeld, completeTask, expireLeases, failTask, LEASE_MS, leaseNext, leaseQueued, StaleLease } from '../../bus/lease.js'
import { FAILURES_TO_STOP, queueTask } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { cardBody, MAIN_2, sha } from './github-fake.js'
import { eventCount, eventsOf, liveBench, spendReviewRounds, taskState } from './merge-bench.js'

const merge = (pr: number, head = sha('a')): string => taskKey({ queue: 'merge', cardId: pr + 100, pr, head })

function allowMerge(bench: MergeBench, pr: number): void {
  recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: 120, text: `[owner] allow-merge PR #${pr} at ${sha('a')} past the round limit`, cards: [] })
}
const WAITING: FakeRun = { status: 'completed', conclusion: 'action_required' }
const APPROVED: FakeRun[] = [{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'success' }, WAITING]
const AWAITING: FakeRun[] = [WAITING, WAITING]

describe('the merge executor', () => {
  it('a pass on a green, clean head is queued for merge and merged with its sha', () => {
    const bench = liveBench()
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

  it('a merge task queued before a card amend waits for the review of the new input, without a failure, and merges after it', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 970 })
    bench.tick()
    completeTask(bench.db, bench.clock.now().toISOString(), leaseNext(bench.db, bench.clock.now().toISOString(), 'review', 'worker:review:s1')!, [])
    bench.gitHub.open({ number: 970, review: 'success' })
    bench.tick()
    const lease = bench.lease()!
    importJournal(bench.db, JSON.stringify({ event: 'intake', task: '1070', card: '#1070 a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —', confirmation: 'auto', corrections: [], bodySha: '0123abcd4567ef89', source: 'admit', ts: '2026-10-11T14:00:00.000Z' }))
    bench.tick()
    const review = leaseNext(bench.db, bench.clock.now().toISOString(), 'review', 'worker:review:s1')!

    expect(bench.merge(lease)).toMatchObject({ kind: 'denied', taskKey: merge(970), denial: { kind: 'technical', reason: 'not_a_candidate', detail: expect.stringContaining(review.taskKey) }, next: 'queued' })
    expect(eventsOf(bench.db, 'policy.denied')).toMatchObject([{ command: 'merge', kind: 'technical', reason: 'not_a_candidate' }])
    expect(taskState(bench.db, merge(970))).toEqual({ state: 'queued', lease_gen: 1, failures: 0 })
    expect(bench.gitHub.puts).toEqual([])

    completeTask(bench.db, bench.clock.now().toISOString(), review, [])
    bench.tick()
    expect(bench.merge(bench.lease()!)).toEqual({ kind: 'merged', taskKey: merge(970), commit: MAIN_2, rule: 'auto' })
    bench.close()
  })

  it('a pull request without a pass, green CI or a clean merge is not queued for merge', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 961 })
    bench.gitHub.open({ number: 962, review: 'failure' })
    bench.gitHub.open({ number: 963, review: 'success', required: 'pending' })
    bench.gitHub.open({ number: 964, review: 'success', mergeable_state: 'behind' })
    bench.gitHub.open({ number: 965, review: 'success', draft: true })
    bench.tick()

    expect(bench.lease()).toBeNull()
    bench.close()
  })

  it('a 409 on merge is a technical stale_head denial that supersedes the lease, requeues it on the unmoved head and leaves the inbox empty', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 966, review: 'success' })
    bench.tick()
    bench.gitHub.mergeStatus = 409

    const outcome = bench.merge(bench.lease()!)
    expect(outcome).toMatchObject({ kind: 'denied', taskKey: merge(966), denial: { kind: 'technical', reason: 'stale_head' }, next: 'superseded' })
    expect(eventsOf(bench.db, 'policy.denied')).toMatchObject([{ command: 'merge', kind: 'technical', reason: 'stale_head' }])
    expect(taskState(bench.db, merge(966))).toEqual({ state: 'superseded', lease_gen: 1, failures: 0 })
    expect(ownerInbox(bench.db)).toEqual([])

    bench.tick()
    expect(taskState(bench.db, merge(966))).toEqual({ state: 'queued', lease_gen: 1, failures: 0 })
    bench.gitHub.mergeStatus = 200
    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'merged', taskKey: merge(966) })
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('a behind or stale-head merge fault never stops the card', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 982, review: 'success' })
    bench.tick()
    bench.gitHub.mergeStatus = 409
    for (let attempt = 0; attempt <= FAILURES_TO_STOP; attempt += 1) {
      expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'stale_head' }, next: 'superseded' })
      bench.tick()
    }
    expect(taskState(bench.db, merge(982))).toMatchObject({ state: 'queued', failures: 0 })

    bench.gitHub.open({ number: 983, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    const ts = bench.clock.now().toISOString()
    queueTask(bench.db, ts, { queue: 'update', cardId: 1083, pr: 983, head: sha('a') })
    queueTask(bench.db, ts, { queue: 'merge', cardId: 1083, pr: 983, head: sha('a') })
    for (let attempt = 0; attempt <= FAILURES_TO_STOP; attempt += 1)
      failTask(bench.db, ts, leaseQueued(bench.db, ts, merge(983), 'worker:merge:worker-1')!, { reason: 'not_mergeable', withdraw: false })
    expect(taskState(bench.db, merge(983))).toMatchObject({ state: 'queued', failures: 0 })
    expect(eventsOf(bench.db, 'card.stopped')).toEqual([])
    expect(eventsOf(bench.db, 'board.alarm')).toEqual([])
    bench.close()
  })

  it('a not_mergeable fault with no update derived for the head counts and stops the card at the third failure', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 984, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    const ts = bench.clock.now().toISOString()
    queueTask(bench.db, ts, { queue: 'merge', cardId: 1084, pr: 984, head: sha('a') })
    for (let attempt = 1; attempt <= FAILURES_TO_STOP; attempt += 1)
      expect(failTask(bench.db, ts, leaseQueued(bench.db, ts, merge(984), 'worker:merge:worker-1')!, { reason: 'not_mergeable', withdraw: false })).toBe(attempt < FAILURES_TO_STOP ? 'queued' : 'stopped')
    expect(taskState(bench.db, merge(984))).toMatchObject({ state: 'stopped', failures: FAILURES_TO_STOP })
    expect(eventsOf(bench.db, 'card.stopped')).toMatchObject([{ reason: 'fault' }])
    bench.close()
  })

  it('a not_mergeable fault on a behind pull request whose update for the head is leased stays uncounted', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 988, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    const ts = bench.clock.now().toISOString()
    queueTask(bench.db, ts, { queue: 'update', cardId: 1088, pr: 988, head: sha('a') })
    queueTask(bench.db, ts, { queue: 'merge', cardId: 1088, pr: 988, head: sha('a') })
    leaseQueued(bench.db, ts, taskKey({ queue: 'update', cardId: 1088, pr: 988, head: sha('a') }), 'worker:update:worker-1')
    for (let attempt = 1; attempt <= FAILURES_TO_STOP; attempt += 1)
      failTask(bench.db, ts, leaseQueued(bench.db, ts, merge(988), 'worker:merge:worker-1')!, { reason: 'not_mergeable', withdraw: false })
    expect(taskState(bench.db, merge(988))).toMatchObject({ state: 'queued', failures: 0 })
    expect(eventsOf(bench.db, 'card.stopped')).toEqual([])
    bench.close()
  })

  it('a not_mergeable fault on a behind pull request counts and stops the card when the only update is for an older head', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 989, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    const ts = bench.clock.now().toISOString()
    queueTask(bench.db, ts, { queue: 'update', cardId: 1089, pr: 989, head: sha('b') })
    queueTask(bench.db, ts, { queue: 'merge', cardId: 1089, pr: 989, head: sha('a') })
    for (let attempt = 1; attempt <= FAILURES_TO_STOP; attempt += 1)
      failTask(bench.db, ts, leaseQueued(bench.db, ts, merge(989), 'worker:merge:worker-1')!, { reason: 'not_mergeable', withdraw: false })
    expect(taskState(bench.db, merge(989))).toMatchObject({ state: 'stopped', failures: FAILURES_TO_STOP })
    expect(eventsOf(bench.db, 'card.stopped')).toMatchObject([{ reason: 'fault' }])
    bench.close()
  })

  it.each([
    ['withdrawn', 990],
    ['completed', 991],
  ] as const)('a not_mergeable fault on a behind pull request counts and stops the card when the update for its head is %s', (ended, pr) => {
    const bench = liveBench()
    bench.gitHub.open({ number: pr, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    const ts = bench.clock.now().toISOString()
    const update = { queue: 'update', cardId: pr + 100, pr, head: sha('a') } as const
    queueTask(bench.db, ts, update)
    queueTask(bench.db, ts, { queue: 'merge', cardId: pr + 100, pr, head: sha('a') })
    const updateLease = leaseQueued(bench.db, ts, taskKey(update), 'worker:update:worker-1')!
    if (ended === 'withdrawn')
      failTask(bench.db, ts, updateLease, { reason: 'not_mergeable', withdraw: true })
    else
      completeTask(bench.db, ts, updateLease, [])
    expect(taskState(bench.db, taskKey(update))).toMatchObject({ state: ended })
    for (let attempt = 1; attempt <= FAILURES_TO_STOP; attempt += 1)
      expect(failTask(bench.db, ts, leaseQueued(bench.db, ts, merge(pr), 'worker:merge:worker-1')!, { reason: 'not_mergeable', withdraw: false })).toBe(attempt < FAILURES_TO_STOP ? 'queued' : 'stopped')
    expect(taskState(bench.db, merge(pr))).toMatchObject({ state: 'stopped', failures: FAILURES_TO_STOP })
    expect(eventsOf(bench.db, 'card.stopped')).toMatchObject([{ reason: 'fault' }])
    bench.close()
  })

  it('a not_mergeable fault on a pull request that is not behind counts and stops the card even with an update queued for its head', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 987, review: 'success', mergeable_state: 'dirty' })
    bench.tick()
    const ts = bench.clock.now().toISOString()
    queueTask(bench.db, ts, { queue: 'update', cardId: 1087, pr: 987, head: sha('a') })
    queueTask(bench.db, ts, { queue: 'merge', cardId: 1087, pr: 987, head: sha('a') })
    for (let attempt = 1; attempt <= FAILURES_TO_STOP; attempt += 1)
      failTask(bench.db, ts, leaseQueued(bench.db, ts, merge(987), 'worker:merge:worker-1')!, { reason: 'not_mergeable', withdraw: false })
    expect(taskState(bench.db, merge(987))).toMatchObject({ state: 'stopped', failures: FAILURES_TO_STOP })
    expect(eventsOf(bench.db, 'card.stopped')).toMatchObject([{ reason: 'fault' }])
    bench.close()
  })

  it('a fault other than not_mergeable on a behind pull request with its update derived counts and stops the card', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 985, review: 'success', mergeable_state: 'behind' })
    bench.tick()
    const ts = bench.clock.now().toISOString()
    queueTask(bench.db, ts, { queue: 'update', cardId: 1085, pr: 985, head: sha('a') })
    queueTask(bench.db, ts, { queue: 'merge', cardId: 1085, pr: 985, head: sha('a') })
    for (let attempt = 1; attempt <= FAILURES_TO_STOP; attempt += 1)
      failTask(bench.db, ts, leaseQueued(bench.db, ts, merge(985), 'worker:merge:worker-1')!, { reason: 'merge_failed', withdraw: false })
    expect(taskState(bench.db, merge(985))).toMatchObject({ state: 'stopped', failures: FAILURES_TO_STOP })
    expect(eventsOf(bench.db, 'card.stopped')).toMatchObject([{ reason: 'fault' }])
    bench.close()
  })

  it('a stale_head after two counted failures supersedes the lease and does not stop the card', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 986, review: 'success' })
    bench.tick()
    const ts = bench.clock.now().toISOString()
    queueTask(bench.db, ts, { queue: 'merge', cardId: 1086, pr: 986, head: sha('a') })
    const failOnce = (reason: string): string => failTask(bench.db, ts, leaseQueued(bench.db, ts, merge(986), 'worker:merge:worker-1')!, { reason, withdraw: false })
    for (let attempt = 1; attempt < FAILURES_TO_STOP; attempt += 1)
      expect(failOnce('merge_failed')).toBe('queued')
    expect(failOnce('stale_head')).toBe('superseded')
    expect(taskState(bench.db, merge(986))).toMatchObject({ state: 'superseded', failures: FAILURES_TO_STOP - 1 })
    expect(eventsOf(bench.db, 'card.stopped')).toEqual([])
    bench.close()
  })

  it('a head that moved before the merge is a technical stale_head denial read from a fresh snapshot', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 967, review: 'success' })
    bench.tick()
    const lease = bench.lease()!
    bench.gitHub.pulls.get(967)!.head = sha('b')

    expect(bench.merge(lease)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'stale_head' }, next: 'superseded' })
    expect(bench.gitHub.puts).toEqual([])
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('an open version pull request whose runs all wait at action_required does not lock the merge', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 978, review: 'success' })
    bench.gitHub.open({ number: 979, head: sha('c'), ref: 'changeset-release/main', runs: AWAITING })
    bench.tick()

    expect(bench.merge(bench.lease()!)).toEqual({ kind: 'merged', taskKey: merge(978), commit: MAIN_2, rule: 'auto' })
    expect(eventsOf(bench.db, 'policy.denied')).toEqual([])
    bench.close()
  })

  it('a version pull request with approved runs on its head locks the merge as technical version_pr_open and requeues', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 980, review: 'success' })
    bench.gitHub.open({ number: 981, head: sha('c'), ref: 'changeset-release/main', runs: APPROVED })
    bench.tick()

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', taskKey: merge(980), denial: { kind: 'technical', reason: 'version_pr_open' }, next: 'queued' })
    expect(eventsOf(bench.db, 'policy.denied')).toMatchObject([{ command: 'merge', kind: 'technical', reason: 'version_pr_open' }])
    expect(taskState(bench.db, merge(980))).toEqual({ state: 'queued', lease_gen: 1, failures: 0 })
    expect(bench.gitHub.puts).toEqual([])
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('an open version pull request locks every merge and requeues without reaching the inbox', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 969, review: 'success' })
    bench.gitHub.open({ number: 970, head: sha('c'), ref: 'changeset-release/main', runs: APPROVED })
    bench.tick()

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', taskKey: merge(969), denial: { kind: 'technical', reason: 'version_pr_open' }, next: 'queued' })
    expect(bench.gitHub.puts).toEqual([])
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('the version pull request lock leaves the task queued however many ticks it lasts, and never stops the card', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 973, review: 'success' })
    bench.gitHub.open({ number: 974, head: sha('c'), ref: 'changeset-release/main', runs: APPROVED })
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
    const bench = liveBench()
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
    const bench = liveBench()
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
    const bench = liveBench()
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
    const bench = liveBench()
    bench.gitHub.open({ number: 976, review: 'success' })
    bench.gitHub.open({ number: 977, head: sha('c'), ref: 'changeset-release/main', runs: APPROVED })
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
    const bench = liveBench()
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
    const bench = liveBench()
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

  it('a PR blocked only by the review context with an owner decision gets merge.done', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 990, review: 'failure', mergeable_state: 'blocked', blockedBy: 'review' })
    spendReviewRounds(bench, 990, sha('a'))
    allowMerge(bench, 990)
    bench.tick()

    expect(bench.merge(bench.lease()!)).toEqual({ kind: 'merged', taskKey: merge(990), commit: MAIN_2, rule: 'owner_after_round_limit' })
    expect(eventsOf(bench.db, 'merge.done')).toEqual([{ commit: MAIN_2, rule: 'owner_after_round_limit' }])
    bench.close()
  })

  it('an owner-path PR with an owner decision gets merge.done', () => {
    for (const pull of [{ number: 991, files: ['scripts/ghosts/approve.ts'] }, { number: 992, body: cardBody(992, 'owner') }]) {
      const bench = liveBench()
      bench.gitHub.open({ review: 'failure', ...pull })
      spendReviewRounds(bench, pull.number, sha('a'))
      allowMerge(bench, pull.number)
      bench.tick()

      expect(bench.merge(bench.lease()!), String(pull.number)).toEqual({ kind: 'merged', taskKey: merge(pull.number), commit: MAIN_2, rule: 'owner_after_round_limit' })
      bench.close()
    }
  })

  it('an owner decision does not lift security_invariants', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 993, review: 'failure', files: ['architecture/security-invariants.md'] })
    spendReviewRounds(bench, 993, sha('a'))
    allowMerge(bench, 993)
    bench.tick()

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'security_invariants' } })
    expect(bench.gitHub.published).toEqual([])
    expect(bench.gitHub.puts).toEqual([])
    bench.close()
  })

  it('a decided PR still blocked after the review status is set is denied not_mergeable and puts no merge', () => {
    const bench = liveBench()
    bench.gitHub.open({ number: 996, review: 'failure', mergeable_state: 'blocked' })
    spendReviewRounds(bench, 996, sha('a'))
    allowMerge(bench, 996)
    bench.tick()

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'not_mergeable' } })
    expect(bench.gitHub.published).toEqual([expect.objectContaining({ commit: sha('a'), context: 'review' })])
    expect(bench.gitHub.puts.filter(put => put.endpoint.endsWith('/merge'))).toEqual([])
    bench.close()
  })

  it('a decided PR that moves, closes or cannot be read after the review status is set puts no merge', () => {
    const afterTheStatus: Record<string, { change: (bench: MergeBench) => void, reason: string }> = {
      'head moved': { change: bench => bench.gitHub.open({ number: 997, head: sha('c'), review: 'failure' }), reason: 'stale_head' },
      'closed': { change: bench => bench.gitHub.close(997, false), reason: 'stale_head' },
      'GitHub failing': { change: (bench) => { bench.gitHub.failing = true }, reason: 'github_error' },
    }
    for (const [name, { change, reason }] of Object.entries(afterTheStatus)) {
      const bench = liveBench()
      bench.gitHub.open({ number: 997, review: 'failure' })
      spendReviewRounds(bench, 997, sha('a'))
      allowMerge(bench, 997)
      bench.tick()
      const lease = bench.lease()!
      const published = bench.gitHub.published
      published.push = (...statuses) => {
        change(bench)
        return Array.prototype.push.apply(published, statuses)
      }

      expect(bench.merge(lease), name).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason } })
      expect(bench.gitHub.puts.filter(put => put.endpoint.endsWith('/merge')), name).toEqual([])
      bench.close()
    }
  })

  it('without a decision an owner-path or review-blocked PR is not merged', () => {
    const blocked = liveBench()
    blocked.gitHub.open({ number: 994, review: 'failure', mergeable_state: 'blocked', blockedBy: 'review' })
    spendReviewRounds(blocked, 994, sha('a'))
    blocked.tick()

    expect(blocked.lease()).toBeNull()
    blocked.close()

    const ownerPath = liveBench()
    ownerPath.gitHub.open({ number: 995, review: 'success', files: ['scripts/ghosts/approve.ts'] })
    ownerPath.tick()

    expect(ownerPath.merge(ownerPath.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'authority', rule: 'owner_by_risk' } })
    expect(ownerPath.gitHub.puts).toEqual([])
    ownerPath.close()
  })

  it('a command with a stale lease_gen is refused and writes nothing', () => {
    const bench = liveBench()
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

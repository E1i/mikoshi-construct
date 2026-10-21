import type { AuthorityRule } from '../../bus/policy.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { MERGE_DONE, PR_OPENED, REVIEW_RECORDED } from '../../bus/card-automaton.js'
import { appendEvent } from '../../bus/db.js'
import { recordDecision } from '../../bus/decisions.js'
import { importJournal } from '../../bus/import.js'
import { TICK_MS } from '../../bus/netwatch.js'
import { pastRoundLimit, underOwnerDecision } from '../../bus/policy.js'
import { changesRoundsOf, closedByRounds, REVIEW_ROUNDS } from '../../bus/queue.js'
import { fullReview } from '../../bus/review-depth.js'
import { REVIEW_ROUNDS_SPENT, ReviewWorker } from '../../bus/review-worker.js'
import { dryRunHoldsAt, observedHeadsOf, roundLimitDecisionOf } from '../../bus/round-limit-decision.js'
import { cleanUpdatesOf } from '../../bus/update-done.js'
import { manualUpdateDone } from '../../bus/update-executor.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, liveBench, spendReviewRounds } from './merge-bench.js'

const PR = 970
const HEAD = sha('a')
const DECISION = 120
const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function roundLimited(): MergeBench {
  const bench = liveBench()
  benches.push(bench)
  bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
  spendReviewRounds(bench, PR, HEAD)
  return bench
}

function decide(bench: MergeBench, text: string): void {
  recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: DECISION, text, cards: [] })
}

function queuedFor(bench: MergeBench, pr: number): string[] {
  return (bench.db.prepare(`SELECT queue FROM tasks WHERE pr = ? AND state = 'queued' ORDER BY queue`).all(pr) as { queue: string }[]).map(row => row.queue)
}

describe('a merge past the review round limit by an owner decision', () => {
  it('a round-limited PR without a decision is not a merge candidate', () => {
    const bench = roundLimited()
    bench.tick()

    expect(changesRoundsOf(bench.db, PR)).toBe(REVIEW_ROUNDS)
    expect(queuedFor(bench, PR)).toEqual([])
  })

  it('a card amend on the same head spends no round', async () => {
    const bench = liveBench()
    benches.push(bench)
    const worker = new ReviewWorker({
      isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
      db: bench.db,
      gitHub: bench.gitHub.client,
      publish: (status) => {
        bench.gitHub.pulls.get(PR)!.review = status.state
      },
      reviewer: async () => ({ verdict: 'changes', findings: ['a.ts:1 the finding'], session: 'reviewer-1' }),
      plan: () => fullReview('a fixed plan'),
      clock: bench.clock.now,
      session: 'worker-1',
    })
    const amends = Array.from({ length: REVIEW_ROUNDS }, (_, at) => `${at + 1}123abcd4567ef89`)
    const reviewed = (): { head: string, card_body: unknown }[] => (bench.db.prepare(`SELECT head, json_extract(payload, '$.card_body') AS card_body FROM events WHERE type = ? AND pr = ? ORDER BY id`).all(REVIEW_RECORDED, PR) as { head: string, card_body: unknown }[]).map(row => ({ head: row.head, card_body: row.card_body }))

    for (const head of [sha('1'), HEAD]) {
      bench.gitHub.open({ number: PR, head, body: cardBody(PR) })
      bench.tick()
      expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes' })
    }
    for (const amend of amends) {
      bench.tick()
      importJournal(bench.db, JSON.stringify({ event: 'intake', task: String(PR + 100), card: `#${PR + 100} a-card [implement/netwatch/S/cheap/auto] · depends — · blocks —`, confirmation: 'auto', corrections: [], bodySha: amend, source: 'admit', ts: '2026-10-11T14:00:00.000Z' }))
      bench.tick()
      expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes', taskKey: expect.stringContaining(`:card-body-${amend}`) })
    }

    expect(reviewed()).toEqual([{ head: sha('1'), card_body: null }, { head: HEAD, card_body: null }, ...amends.map(amend => ({ head: HEAD, card_body: amend }))])
    expect(changesRoundsOf(bench.db, PR)).toBe(2)
    expect(eventsOf(bench.db, REVIEW_ROUNDS_SPENT)).toEqual([])
    for (const queue of ['review', 'answer'] as const)
      expect(closedByRounds(bench.db, bench.clock.now().toISOString(), queue, PR, HEAD), queue).toBe(false)
  })

  it('a decision naming the PR and its head makes it a merge candidate and queues no review or answer', () => {
    for (const text of [`[owner] allow-merge PR #${PR} at ${HEAD} past the round limit`, `allow-merge PR #${PR} at ${HEAD} past the round limit`, `allow-merge PR #${PR} at ${HEAD} past the round limit · until 2026-10-20T00:00Z`]) {
      const bench = roundLimited()
      decide(bench, text)
      bench.tick()

      expect(queuedFor(bench, PR), text).toEqual(['merge'])
      expect(changesRoundsOf(bench.db, PR)).toBe(REVIEW_ROUNDS)
    }
  })

  it('a decision naming another sha or another PR does not make it a merge candidate', () => {
    for (const text of [`allow-merge PR #${PR} at ${sha('b')}`, `allow-merge PR #${PR + 1} at ${HEAD}`, `allow-merge PR #${PR}1 at ${HEAD}`, `allow-merge PR #${PR} at ${HEAD.slice(0, 12)}`]) {
      const bench = roundLimited()
      decide(bench, text)
      bench.tick()

      expect(queuedFor(bench, PR), text).toEqual([])
    }
  })

  it('(д) a decision naming the PR and its head without the allow-merge marker is not a merge candidate', () => {
    for (const text of [`PR #${PR} at ${HEAD}: hold the merge`, `PR #${PR} merges at ${HEAD} past the round limit`, `PR #${PR} at ${HEAD}: never allow-merged`]) {
      const bench = roundLimited()
      decide(bench, text)
      bench.tick()

      expect(queuedFor(bench, PR), text).toEqual([])
    }
  })

  it('(е) a decision that negates or withdraws allow-merge for the PR and its head is not a merge candidate', () => {
    for (const text of [`[owner] do not allow-merge PR #${PR} at ${HEAD}`, `[owner] allow-merge withdrawn for PR #${PR} at ${HEAD}`, `[owner] hold: allow-merge PR #${PR} at ${HEAD} only after the owner looks`]) {
      const bench = roundLimited()
      decide(bench, text)
      bench.tick()

      expect(queuedFor(bench, PR), text).toEqual([])
    }
  })

  it('a PR below the round limit gets no merge task without a pass, with a decision or without', () => {
    for (const text of [null, `allow-merge PR #${PR + 1} at ${sha('e')} past the round limit`]) {
      const bench = liveBench()
      benches.push(bench)
      bench.gitHub.open({ number: PR + 1, head: sha('e'), review: 'failure' })
      if (text !== null)
        decide(bench, text)
      bench.tick()

      expect(queuedFor(bench, PR + 1).filter(queue => queue === 'merge'), String(text)).toEqual([])
    }
  })

  it('the merge rule and its detail name the decision D-N', () => {
    const bench = roundLimited()
    decide(bench, `[owner] allow-merge PR #${PR} at ${HEAD} past the round limit`)
    bench.tick()

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'merged', rule: 'owner_after_round_limit' })
    expect(eventsOf(bench.db, MERGE_DONE)).toEqual([expect.objectContaining({ rule: 'owner_after_round_limit' })])
    expect(pastRoundLimit('card #1070 is auto', DECISION, PR, HEAD).detail).toContain(`D-${DECISION}`)
  })

  it('under an owner decision r1 and the owner-path denials yield, and every other denial stands', () => {
    const underTheDecision: Record<AuthorityRule, 'allowed' | 'denied'> = {
      owner_by_risk: 'allowed',
      owner_without_shard: 'allowed',
      r1: 'allowed',
      security_invariants: 'denied',
      reserved: 'denied',
      decision_unread: 'denied',
      version_pr: 'denied',
    }
    for (const [rule, kind] of Object.entries(underTheDecision))
      expect(underOwnerDecision({ kind: 'denied', rule: rule as AuthorityRule, detail: rule }, DECISION, PR, HEAD), rule).toMatchObject({ kind })
  })

  it('the review status is set on the decided head with D-N before the merge and never on another head', () => {
    const bench = roundLimited()
    decide(bench, `[owner] allow-merge PR #${PR} at ${HEAD} past the round limit`)
    bench.tick()
    const putsAtPublish: number[] = []
    const published = bench.gitHub.published
    published.push = (...statuses) => {
      putsAtPublish.push(bench.gitHub.puts.length)
      return Array.prototype.push.apply(published, statuses)
    }
    const merged = bench.merge(bench.lease()!)

    expect(merged).toMatchObject({ kind: 'merged' })
    expect([...bench.gitHub.published]).toEqual([expect.objectContaining({ commit: HEAD, state: 'success', context: 'review', description: expect.stringContaining(`owner decision D-${DECISION}, no review pass`) })])
    expect(bench.gitHub.puts.filter(put => put.endpoint.endsWith('/merge')).map(put => put.fields.sha)).toEqual([HEAD])
    expect(putsAtPublish).toEqual([0])

    const moved = roundLimited()
    decide(moved, `[owner] allow-merge PR #${PR} at ${HEAD} past the round limit`)
    moved.tick()
    const lease = moved.lease()!
    moved.gitHub.open({ number: PR, head: sha('c'), review: 'failure' })

    expect(moved.merge(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'stale_head' } })
    expect(moved.gitHub.published).toEqual([])
    expect(moved.gitHub.puts.filter(put => put.endpoint.endsWith('/merge'))).toEqual([])
  })

  it('a review status GitHub refuses denies the merge as github_error and puts no merge', () => {
    const bench = roundLimited()
    decide(bench, `[owner] allow-merge PR #${PR} at ${HEAD} past the round limit`)
    bench.tick()
    bench.gitHub.published.push = () => {
      throw new Error('gh api: 422 status refused')
    }

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'github_error' } })
    expect(bench.gitHub.puts.filter(put => put.endpoint.endsWith('/merge'))).toEqual([])
    expect(eventsOf(bench.db, MERGE_DONE)).toEqual([])
  })

  it('an open version pull request locks a decided merge before any review status is set', () => {
    const bench = roundLimited()
    decide(bench, `[owner] allow-merge PR #${PR} at ${HEAD} past the round limit`)
    bench.tick()
    bench.gitHub.open({ number: PR + 2, head: sha('f'), ref: 'changeset-release/main', runs: [{ status: 'completed', conclusion: 'success' }] })

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'version_pr_open' } })
    expect(bench.gitHub.published).toEqual([])
    expect(bench.gitHub.puts.filter(put => put.endpoint.endsWith('/merge'))).toEqual([])
  })

  it('a decision on a head holds for every head a chain of clean updates leads to from it, and for no other', () => {
    const decisions = [{ decisionId: DECISION, text: `[owner] allow-merge PR #${PR} at ${HEAD} past the round limit`, cards: [] }]
    const chain = [{ from: HEAD, to: sha('b') }, { from: sha('b'), to: sha('c') }, { from: sha('c'), to: sha('b') }]

    expect(roundLimitDecisionOf(decisions, PR, sha('c'), chain)).toBe(DECISION)
    expect(roundLimitDecisionOf(decisions, PR, sha('b'), chain)).toBe(DECISION)
    expect(roundLimitDecisionOf(decisions, PR, sha('c'), [{ from: sha('b'), to: sha('c') }])).toBeNull()
    expect(roundLimitDecisionOf(decisions, PR + 1, sha('b'), chain)).toBeNull()
    expect(roundLimitDecisionOf(decisions, PR, sha('e'), chain)).toBeNull()
  })

  it('allow-merge takes the dry-run of the previous head plus one push', () => {
    const observed = [sha('1'), HEAD, sha('b'), sha('c')]

    expect(dryRunHoldsAt(HEAD, HEAD, observed, [])).toBe(true)
    expect(dryRunHoldsAt(HEAD, sha('b'), observed, [])).toBe(true)
    expect(dryRunHoldsAt(HEAD, sha('d'), observed, [{ from: sha('b'), to: sha('d') }])).toBe(true)
    expect(dryRunHoldsAt(HEAD, sha('c'), observed, [])).toBe(false)
    expect(dryRunHoldsAt(HEAD, sha('1'), observed, [])).toBe(false)
    expect(dryRunHoldsAt(HEAD, sha('e'), observed, [])).toBe(false)
    expect(dryRunHoldsAt('abc', sha('b'), observed, [])).toBe(false)
  })

  it('one push is one observed head: the head pr.opened recorded counts, so a dry-run there holds across the push to the next observed head', () => {
    const bench = liveBench()
    benches.push(bench)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: 1087, pr: 987, head: sha('1'), dedupeKey: `${PR_OPENED}:1087:987`, payload: { pr: 987 }, legacy: false })
    bench.gitHub.open({ number: 987, review: 'success', head: sha('b') })
    bench.tick()

    const observed = observedHeadsOf(bench.db, 987)
    expect(observed).toEqual([sha('1'), sha('b')])
    expect(dryRunHoldsAt(sha('1'), sha('b'), observed, [])).toBe(true)
  })

  it('a head observed again collapses only into its own neighbour, and the head before a push is the one before its last observation', () => {
    const bench = liveBench()
    benches.push(bench)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: 1088, pr: 988, head: sha('a'), dedupeKey: `${PR_OPENED}:1088:988`, payload: { pr: 988 }, legacy: false })
    for (const head of [sha('a'), sha('b'), sha('a'), sha('c')]) {
      bench.gitHub.open({ number: 988, review: 'success', head })
      bench.tick()
    }

    const observed = observedHeadsOf(bench.db, 988)
    expect(observed).toEqual([sha('a'), sha('b'), sha('a'), sha('c')])
    expect(dryRunHoldsAt(sha('a'), sha('c'), observed, [])).toBe(true)
    expect(dryRunHoldsAt(sha('b'), sha('c'), observed, [])).toBe(false)
    expect(dryRunHoldsAt(sha('b'), sha('a'), observed, [])).toBe(true)
  })

  it('a manual update-branch of PR #919 from 4a4dcb5a to b808b64a queues the merge with no new decisions:add', () => {
    const [pr, from, to] = [919, '4a4dcb5a'.padEnd(40, '0'), 'b808b64a'.padEnd(40, '0')]
    const bench = liveBench()
    benches.push(bench)
    bench.gitHub.open({ number: pr, head: from, review: 'failure' })
    spendReviewRounds(bench, pr, from)
    recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: 187, text: `[owner] allow-merge PR #${pr} at ${from} past the round limit`, cards: [] })
    bench.gitHub.open({ number: pr, head: to, review: 'failure' })
    bench.tick()

    expect(queuedFor(bench, pr)).toEqual([])

    appendEvent(bench.db, manualUpdateDone({ ts: bench.clock.now().toISOString(), session: 'window-s78', cardId: 1070, pr, from, to }))
    bench.tick()

    expect(bench.db.prepare(`SELECT head FROM tasks WHERE pr = ? AND state = 'queued' AND queue = 'merge'`).all(pr)).toEqual([{ head: to }])
    expect(bench.db.prepare('SELECT count(*) AS n FROM decisions').get()).toEqual({ n: 1 })
    expect(roundLimitDecisionOf([{ decisionId: 187, text: `allow-merge PR #${pr} at ${from}`, cards: [] }], pr, to, cleanUpdatesOf(bench.db, pr))).toBe(187)
  })

  it('a decision whose term has lapsed, at the tick or by the merge, merges nothing', () => {
    const lapsedAtTick = roundLimited()
    decide(lapsedAtTick, `[owner] allow-merge PR #${PR} at ${HEAD} past the round limit until 2026-10-09T12:00Z`)
    lapsedAtTick.tick()

    expect(queuedFor(lapsedAtTick, PR)).toEqual([])

    const lapsedByMerge = roundLimited()
    decide(lapsedByMerge, `[owner] allow-merge PR #${PR} at ${HEAD} past the round limit until 2026-10-09T12:03Z`)
    lapsedByMerge.tick()
    const lease = lapsedByMerge.lease()!
    lapsedByMerge.clock.advance(3 * TICK_MS)

    expect(lapsedByMerge.merge(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'no_pass_on_head' } })
    expect(lapsedByMerge.gitHub.published).toEqual([])
    expect(lapsedByMerge.gitHub.puts.filter(put => put.endpoint.endsWith('/merge'))).toEqual([])
  })
})

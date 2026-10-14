import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { MERGE_DONE, REVIEW_RECORDED } from '../../bus/card-automaton.js'
import { appendEvent } from '../../bus/db.js'
import { recordDecision } from '../../bus/decisions.js'
import { TICK_MS } from '../../bus/netwatch.js'
import { pastRoundLimit } from '../../bus/policy.js'
import { changesRoundsOf, REVIEW_ROUNDS } from '../../bus/queue.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const PR = 970
const HEAD = sha('a')
const DECISION = 120
const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function roundLimited(): MergeBench {
  const bench = mergeBench()
  benches.push(bench)
  bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
  for (let round = 1; round <= REVIEW_ROUNDS; round += 1)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: `worker:review:session-${round}`, cardId: PR + 100, pr: PR, head: HEAD, dedupeKey: `${REVIEW_RECORDED}:round-${round}`, payload: { head: HEAD, verdict: 'changes', reviewer_session: `session-${round}`, findings: [] }, legacy: false })
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

  it('a decision naming the PR and its head makes it a merge candidate and queues no review or answer', () => {
    const bench = roundLimited()
    decide(bench, `PR #${PR} merges at ${HEAD} past the round limit`)
    bench.tick()

    expect(queuedFor(bench, PR)).toEqual(['merge'])
    expect(changesRoundsOf(bench.db, PR)).toBe(REVIEW_ROUNDS)
  })

  it('a decision naming another sha or another PR does not make it a merge candidate', () => {
    for (const text of [`PR #${PR} merges at ${sha('b')}`, `PR #${PR + 1} merges at ${HEAD}`, `PR #${PR}1 merges at ${HEAD}`, `PR #${PR} merges at ${HEAD.slice(0, 12)}`]) {
      const bench = roundLimited()
      decide(bench, text)
      bench.tick()

      expect(queuedFor(bench, PR), text).toEqual([])
    }
  })

  it('a PR below the round limit gets no merge task without a pass, with a decision or without', () => {
    for (const text of [null, `PR #${PR + 1} merges at ${sha('e')} past the round limit`]) {
      const bench = mergeBench()
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
    decide(bench, `PR #${PR} merges at ${HEAD} past the round limit`)
    bench.tick()

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'merged', rule: 'owner_after_round_limit' })
    expect(eventsOf(bench.db, MERGE_DONE)).toEqual([expect.objectContaining({ rule: 'owner_after_round_limit' })])
    expect(pastRoundLimit('card #1070 is auto', DECISION, PR, HEAD).detail).toContain(`D-${DECISION}`)
  })

  it('the review status is set on the decided head with D-N before the merge and never on another head', () => {
    const bench = roundLimited()
    decide(bench, `PR #${PR} merges at ${HEAD} past the round limit`)
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
    decide(moved, `PR #${PR} merges at ${HEAD} past the round limit`)
    moved.tick()
    const lease = moved.lease()!
    moved.gitHub.open({ number: PR, head: sha('c'), review: 'failure' })

    expect(moved.merge(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'stale_head' } })
    expect(moved.gitHub.published).toEqual([])
    expect(moved.gitHub.puts.filter(put => put.endpoint.endsWith('/merge'))).toEqual([])
  })

  it('a review status GitHub refuses denies the merge as github_error and puts no merge', () => {
    const bench = roundLimited()
    decide(bench, `PR #${PR} merges at ${HEAD} past the round limit`)
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
    decide(bench, `PR #${PR} merges at ${HEAD} past the round limit`)
    bench.tick()
    bench.gitHub.open({ number: PR + 2, head: sha('f'), ref: 'changeset-release/main', runs: [{ status: 'completed', conclusion: 'success' }] })

    expect(bench.merge(bench.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'version_pr_open' } })
    expect(bench.gitHub.published).toEqual([])
    expect(bench.gitHub.puts.filter(put => put.endpoint.endsWith('/merge'))).toEqual([])
  })

  it('a decision whose term has lapsed, at the tick or by the merge, merges nothing', () => {
    const lapsedAtTick = roundLimited()
    decide(lapsedAtTick, `PR #${PR} merges at ${HEAD} past the round limit until 2026-10-09T12:00Z`)
    lapsedAtTick.tick()

    expect(queuedFor(lapsedAtTick, PR)).toEqual([])

    const lapsedByMerge = roundLimited()
    decide(lapsedByMerge, `PR #${PR} merges at ${HEAD} past the round limit until 2026-10-09T12:03Z`)
    lapsedByMerge.tick()
    const lease = lapsedByMerge.lease()!
    lapsedByMerge.clock.advance(3 * TICK_MS)

    expect(lapsedByMerge.merge(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'no_pass_on_head' } })
    expect(lapsedByMerge.gitHub.published).toEqual([])
    expect(lapsedByMerge.gitHub.puts.filter(put => put.endpoint.endsWith('/merge'))).toEqual([])
  })
})

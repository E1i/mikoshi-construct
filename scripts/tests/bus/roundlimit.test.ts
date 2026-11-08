import type { Lease } from '../../core/lease.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STOPPED, REVIEW_RECORDED } from '../../core/events.js'
import { taskKey } from '../../core/identifiers.js'
import { completeTask, leaseNext } from '../../core/lease.js'
import { closedByRounds, queueTask, reentryLimitWaitText, REVIEW_ROUNDS } from '../../core/queue.js'
import { answerSourceOf } from '../../nodes/answer/answer-source.js'
import { recordDecision } from '../../policy/decisions.js'
import { CONTINUE_FIXES, continueFixesDecisionOf, pushedAfterContinueFixes } from '../../policy/round-limit-decision.js'
import { sha } from './github-fake.js'
import { liveBench } from './merge-bench.js'

const PR = 971
const CARD = PR + 100
const HEAD = sha('a')
const PUSHED = sha('b')
const DECISION = 121
const FINDING = 'scripts/a.ts:run drops the second row'
const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function review(bench: MergeBench, head: string, verdict: 'changes' | 'pass', round: string, findings: string[] = []): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: `worker:review:${round}`, cardId: CARD, pr: PR, head, dedupeKey: `${REVIEW_RECORDED}:${round}`, payload: { head, verdict, reviewer_session: round, findings }, legacy: false })
}

function roundLimited(): MergeBench {
  const bench = liveBench()
  benches.push(bench)
  bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
  for (let round = 1; round < REVIEW_ROUNDS; round += 1)
    review(bench, sha(String(round)), 'changes', `round-${round}`)
  review(bench, HEAD, 'changes', `round-${REVIEW_ROUNDS}`, [FINDING])
  bench.tick()
  return bench
}

function decide(bench: MergeBench, text: string): void {
  recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: DECISION, text, cards: [] })
}

function queued(bench: MergeBench): { queue: string, head: string }[] {
  return bench.db.prepare(`SELECT queue, head FROM tasks WHERE pr = ? AND state = 'queued' ORDER BY queue`).all(PR) as { queue: string, head: string }[]
}

function leaseOf(bench: MergeBench): Lease {
  const row = bench.db.prepare(`SELECT task_key, lease_gen FROM tasks WHERE pr = ? AND queue = 'answer' AND state = 'queued'`).get(PR) as { task_key: string, lease_gen: number }
  return { taskKey: row.task_key, queue: 'answer', cardId: CARD, pr: PR, head: HEAD, leaseGen: row.lease_gen, actor: 'worker:answer:test' } as Lease
}

describe('continue-fixes past the review round limit', () => {
  it('continue after the round limit queues an answer on the current head', () => {
    const bench = roundLimited()

    expect(queued(bench)).toEqual([])

    decide(bench, `[owner] continue-fixes PR #${PR} at ${HEAD}`)
    bench.tick()

    expect(queued(bench)).toEqual([{ queue: 'answer', head: HEAD }])
    expect(answerSourceOf(bench.db, leaseOf(bench))).toMatchObject({ kind: 'changes', findings: [FINDING] })
    expect(closedByRounds(bench.db, bench.clock.now().toISOString(), 'merge', PR, HEAD)).toBe(true)
  })

  it('the push after a continue gets a review, and merges only after a pass on it', () => {
    const bench = roundLimited()
    decide(bench, `[owner] continue-fixes PR #${PR} at ${HEAD}`)
    bench.tick()
    bench.gitHub.open({ number: PR, head: PUSHED, review: 'failure' })
    bench.tick()
    const ts = (): string => bench.clock.now().toISOString()

    expect(closedByRounds(bench.db, ts(), 'review', PR, PUSHED)).toBe(false)
    expect(closedByRounds(bench.db, ts(), 'answer', PR, PUSHED)).toBe(true)
    expect(queued(bench).filter(task => task.queue === 'merge')).toEqual([])

    review(bench, PUSHED, 'pass', 'after-continue')
    bench.gitHub.open({ number: PR, head: PUSHED, review: 'success' })
    bench.tick()

    expect(queued(bench).filter(task => task.queue === 'merge')).toEqual([{ queue: 'merge', head: PUSHED }])
  })

  it('a changes review on the push after a continue closes the rounds again', () => {
    const bench = roundLimited()
    decide(bench, `[owner] continue-fixes PR #${PR} at ${HEAD}`)
    bench.tick()
    bench.gitHub.open({ number: PR, head: PUSHED, review: 'failure' })
    bench.tick()
    review(bench, PUSHED, 'changes', 'after-continue', [FINDING])
    bench.gitHub.open({ number: PR, head: sha('c'), review: 'failure' })
    bench.tick()
    const ts = bench.clock.now().toISOString()

    for (const queue of ['review', 'answer', 'merge'] as const)
      expect(closedByRounds(bench.db, ts, queue, PR, sha('c')), queue).toBe(true)
    expect(closedByRounds(bench.db, ts, 'answer', PR, PUSHED)).toBe(true)
  })

  it('a decision on another head or PR, or under allow-merge, continues nothing', () => {
    for (const text of [`continue-fixes PR #${PR} at ${sha('e')}`, `continue-fixes PR #${PR + 1} at ${HEAD}`, `continue-fixes PR #${PR} at ${HEAD.slice(0, 12)}`, `[owner] do not continue-fixes PR #${PR} at ${HEAD}`]) {
      const bench = roundLimited()
      decide(bench, text)
      bench.tick()

      expect(queued(bench), text).toEqual([])
    }
  })

  it('a card decision past the round limit queues exactly one continuation task without an amend', () => {
    const bench = roundLimited()
    const admissions = (): unknown => bench.db.prepare(`SELECT count(*) AS n FROM events WHERE type = '${CARD_ADMITTED}' AND card_id = ?`).get(CARD)
    const before = admissions()
    expect(queued(bench)).toEqual([])

    recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: DECISION, text: '[owner] keep fixing the second row, one more round', cards: [CARD] })
    bench.tick()
    bench.tick()

    const decided = `${taskKey({ queue: 'answer', cardId: CARD, pr: PR, head: HEAD })}:decision-${DECISION}`
    expect(bench.db.prepare(`SELECT task_key, state FROM tasks WHERE pr = ? AND queue IN ('answer', 'review', 'witness') ORDER BY task_key`).all(PR)).toEqual([{ task_key: decided, state: 'queued' }])
    expect(answerSourceOf(bench.db, leaseOf(bench))).toMatchObject({ kind: 'decision', decisionId: DECISION })
    expect(admissions()).toEqual(before)
  })

  it('past the round limit a faulted decision task is set again, and a faulted plain answer task is not', () => {
    const faulted = (bench: MergeBench, key: string): string => {
      const lease = leaseNext(bench.db, bench.clock.now().toISOString(), 'answer', 'worker:answer:test')!
      expect(lease.taskKey).toBe(key)
      completeTask(bench.db, bench.clock.now().toISOString(), lease, [{ ts: bench.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:answer:test', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `${CARD_STOPPED}:${key}:${lease.leaseGen}`, payload: { reason: 'fault', detail: 'the chain fell' }, legacy: false }])
      bench.tick()
      return (bench.db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(key) as { state: string }).state
    }
    const plain = taskKey({ queue: 'answer', cardId: CARD, pr: PR, head: HEAD })

    const decided = roundLimited()
    recordDecision(decided.db, { ts: decided.clock.now().toISOString(), decisionId: DECISION, text: '[owner] keep fixing the second row, one more round', cards: [CARD] })
    decided.tick()
    expect(closedByRounds(decided.db, decided.clock.now().toISOString(), 'answer', PR, HEAD)).toBe(true)
    expect(faulted(decided, `${plain}:decision-${DECISION}`)).toBe('queued')

    const undecided = roundLimited()
    expect(queueTask(undecided.db, undecided.clock.now().toISOString(), { queue: 'answer', cardId: CARD, pr: PR, head: HEAD })).toBe(true)
    expect(faulted(undecided, plain)).toBe('completed')
  })

  it('past the round limit a decision whose continuation already ran queues no second one on the pushed head', () => {
    const bench = roundLimited()
    recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: DECISION, text: '[owner] keep fixing the second row, one more round', cards: [CARD] })
    bench.tick()
    const lease = leaseNext(bench.db, bench.clock.now().toISOString(), 'answer', 'worker:answer:test')!
    expect(lease.taskKey).toBe(`${taskKey({ queue: 'answer', cardId: CARD, pr: PR, head: HEAD })}:decision-${DECISION}`)
    completeTask(bench.db, bench.clock.now().toISOString(), lease, [])
    bench.gitHub.open({ number: PR, head: PUSHED, review: 'failure' })
    bench.tick()
    bench.tick()

    expect(bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer' AND task_key LIKE '%:decision-%' ORDER BY task_key`).all()).toEqual([{ task_key: lease.taskKey }])
  })

  it('past the round limit a card decision recorded before the last review continues nothing', () => {
    const bench = liveBench()
    benches.push(bench)
    bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
    for (let round = 1; round < REVIEW_ROUNDS; round += 1)
      review(bench, sha(String(round)), 'changes', `round-${round}`)
    recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: DECISION, text: '[owner] keep fixing the second row, one more round', cards: [CARD] })
    review(bench, HEAD, 'changes', `round-${REVIEW_ROUNDS}`, [FINDING])
    bench.tick()
    bench.tick()

    expect(closedByRounds(bench.db, bench.clock.now().toISOString(), 'answer', PR, HEAD)).toBe(true)
    expect(queued(bench)).toEqual([])
  })

  it('the round-limit wait names continue-fixes for the PR beside allow-merge, a re-cut and a drop', () => {
    const text = reentryLimitWaitText(CARD, PR)

    expect(text).toContain(`${CONTINUE_FIXES} PR #${PR} at its head`)
    expect(text).toMatch(/allow-merge, continue-fixes PR #971 at its head, a re-cut or a drop$/)
  })

  it('reads the continued head through clean updates and counts one round after it', () => {
    const decisions = [{ decisionId: DECISION, text: `continue-fixes PR #${PR} at ${HEAD}`, cards: [] }]
    const observedHeads = [sha('1'), HEAD, sha('d'), PUSHED, sha('c')]
    const cleanUpdates = [{ from: HEAD, to: sha('d') }]

    expect(continueFixesDecisionOf(decisions, PR, sha('d'), cleanUpdates)).toBe(DECISION)
    expect(continueFixesDecisionOf(decisions, PR, PUSHED, cleanUpdates)).toBeNull()
    expect(pushedAfterContinueFixes(decisions, PR, PUSHED, { observedHeads, cleanUpdates, changesHeads: new Set([HEAD]) })).toBe(true)
    expect(pushedAfterContinueFixes(decisions, PR, sha('d'), { observedHeads, cleanUpdates, changesHeads: new Set() })).toBe(false)
    expect(pushedAfterContinueFixes(decisions, PR, sha('c'), { observedHeads, cleanUpdates, changesHeads: new Set([PUSHED]) })).toBe(false)
    expect(pushedAfterContinueFixes(decisions, PR, sha('1'), { observedHeads, cleanUpdates, changesHeads: new Set() })).toBe(false)
    expect(pushedAfterContinueFixes(decisions, PR, sha('f'), { observedHeads, cleanUpdates, changesHeads: new Set() })).toBe(false)
  })
})

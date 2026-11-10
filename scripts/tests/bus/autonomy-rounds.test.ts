import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ANSWERED, CARD_STARTED, REVIEW_RECORDED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor, unprovedFindings, unprovedFindingsLine } from '../../nodes/answer/answer-executor.js'
import { dryRunIn, keepDryRun } from '../../nodes/review/dry-run-record.js'
import { PrCloser } from '../../nodes/review/pr-close.js'
import { sayToOwnerChannel, USED_WORD } from '../../owner/channel.js'
import { roundLimitDecisionOf } from '../../policy/round-limit-decision.js'
import { decisionsInForceAt } from '../../policy/shards.js'
import { decisionsAdder } from '../../window/window-request-tools.js'
import { ALLOW_MERGE_RECORD, ANSWER_SOURCE, HEAD_WORD, requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'
import { sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench, spendReviewRounds } from './merge-bench.js'

const PR = 1742
const CARD = PR + 100
const HEAD = sha('a')
const ANSWERED_HEAD = sha('b')
const SESSION = 'window-1'
const DRY_RUN = 'reviewer-dry'
const FINDINGS = ['scripts/a.ts:run drops the error', 'no test covers the empty list']

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const bench of benches.splice(0))
    bench.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function rootDir(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

interface Window {
  bench: MergeBench
  root: string
  requests: WindowRequests
  decisions: () => string
}

function windowAtTheLimit(): Window {
  const bench = liveBench()
  benches.push(bench)
  const root = rootDir('autonomy-rounds-window-')
  mkdirSync(path.join(root, path.dirname(ALLOW_MERGE_RECORD)), { recursive: true })
  writeFileSync(path.join(root, ALLOW_MERGE_RECORD), '# The window allows a merge past the review round limit\n\nStatus: accepted\n')
  mkdirSync(path.join(root, '.construct', 'handoff'), { recursive: true })
  const decisions = path.join(root, '.construct', 'owner-decisions.md')
  writeFileSync(decisions, '# Owner decisions\n\n- D-1 · 2026-10-08 — first. · decisions:add\n')
  bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
  spendReviewRounds(bench, PR, HEAD)
  bench.tick()
  const closer = (): PrCloser => new PrCloser(bench.db, bench.gitHub.client, bench.gitHub.patch, bench.clock.now)
  const requests = new WindowRequests(bench.db, bench.clock.now, {
    treeOf: cardId => path.join(root, 'worktrees', `mc-${cardId}`),
    exists: existsSync,
    cutTree: () => {},
    dryRunOf: dryRunIn(path.join(root, 'dry-run-reviews')),
    addDecision: decisionsAdder(bench.db, decisions, bench.clock.now),
    causeHolds: () => null,
    closePr: request => closer().close(request),
    closeDropped: () => closer().closeDropped(),
  }, path.join(root, 'owner-answers'), () => '0.47.0', root, bench.gitHub.client)
  return { bench, root, requests, decisions: () => readFileSync(decisions, 'utf8') }
}

function asked(window: Window, request: Record<string, unknown>): number {
  return requestFromWindow(window.bench.db, window.bench.clock.now().toISOString(), SESSION, request)
}

function ownerSaid(window: Window, words: string): void {
  sayToOwnerChannel(path.join(window.root, 'owner-answers'), words, window.bench.clock.now())
}

interface Changes {
  bench: MergeBench
  executor: (answerer: Answerer) => AnswerExecutor
  lease: () => Lease
}

function changesOnTheHead(): Changes {
  const bench = mergeBench()
  benches.push(bench)
  const home = rootDir('autonomy-rounds-answer-')
  const worktree = path.join(home, `mc-${CARD}`)
  mkdirSync(worktree)
  const ts = bench.clock.now().toISOString()
  bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
  bench.tick()
  appendEvent(bench.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(bench.db, { ts, type: REVIEW_RECORDED, actor: 'worker:review:review-1', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `${REVIEW_RECORDED}:${PR}:${HEAD}`, payload: { head: HEAD, verdict: 'changes', reviewer_session: 'reviewer-1', findings: FINDINGS }, legacy: false })
  bench.tick()
  queueTask(bench.db, ts, { queue: 'answer', cardId: CARD, pr: PR, head: HEAD })
  const trees: CardTreeTools = { home, exists: existsSync, branchOf: pr => `feat/card-${pr + 100}`, recreate: () => {}, bringTo: () => {} }
  return {
    bench,
    executor: answerer => new AnswerExecutor({ db: bench.db, answerer, ownerMerges: () => '', clock: bench.clock.now, trees, dirty: () => false, liveSession: () => null, prepare: () => {}, mergeMain: () => () => ({ kind: 'inside', files: [] }) }),
    lease: () => leaseNext(bench.db, bench.clock.now().toISOString(), 'answer', 'worker:answer:answer-1')!,
  }
}

function answering(proofs?: { finding: string, proof: string }[]): Answerer {
  return async () => ({ session: 'card-session-1', resumed: true, before: HEAD, after: ANSWERED_HEAD, owner: null, ...(proofs === undefined ? {} : { proofs }) })
}

describe('autonomy rounds at the window and the answer', () => {
  it('a decision at head gets its sha from the bus', () => {
    const window = windowAtTheLimit()
    const { bench } = window
    const words = `continue-fixes PR #${PR} at ${HEAD_WORD}: one more round on the new findings`
    ownerSaid(window, words)
    const decision = asked(window, { kind: 'decisions:add', text: `[owner] ${words}`, from: ANSWER_SOURCE, cards: [`#${CARD}`] })

    expect(window.requests.run()).toEqual([expect.objectContaining({ kind: 'done', request: decision })])
    expect(window.decisions()).toContain(`[owner] continue-fixes PR #${PR} at ${HEAD}: one more round on the new findings`)
    expect(window.decisions()).not.toContain(`at ${HEAD_WORD}`)

    const unobserved = `continue-fixes PR #${PR + 1} at ${HEAD_WORD}`
    ownerSaid(window, unobserved)
    const refused = asked(window, { kind: 'decisions:add', text: `[owner] ${unobserved}`, from: ANSWER_SOURCE })
    expect(window.requests.run()).toEqual([{ kind: 'refused', request: refused, detail: `decisions:add: the decision names a PR at ${HEAD_WORD} whose head the bus has not observed, so the bus has no sha to put in` }])
    expect(readdirSync(path.join(window.root, 'owner-answers')).filter(file => !file.endsWith(USED_WORD))).toHaveLength(1)

    expect(requestOf(['allow-merge', '--pr', String(PR), '--head', HEAD_WORD, '--dry-run', DRY_RUN])).toEqual({ kind: 'allow-merge', pr: PR, head: HEAD_WORD, dry_run: DRY_RUN })
    expect(requestOf(['allow-merge', '--pr', String(PR), '--head', 'tip', '--dry-run', DRY_RUN])).toBeNull()
    mkdirSync(path.join(window.root, 'dry-run-reviews'), { recursive: true })
    keepDryRun(path.join(window.root, 'dry-run-reviews'))(DRY_RUN, { pr: PR, head: HEAD })
    const allowed = asked(window, { kind: 'allow-merge', pr: PR, head: HEAD_WORD, dry_run: DRY_RUN })
    expect(window.requests.run()).toEqual([expect.objectContaining({ kind: 'done', request: allowed })])
    expect(window.decisions()).toContain(`[owner] allow-merge PR #${PR} at ${HEAD} · by ${ALLOW_MERGE_RECORD}`)
    bench.tick()
    expect(roundLimitDecisionOf(decisionsInForceAt(bench.db, bench.clock.now()), PR, HEAD, [])).not.toBeNull()
  })

  it('an answer that leaves a given finding unproved is refused', async () => {
    const refused = changesOnTheHead()
    const unproved = await refused.executor(answering([{ finding: FINDINGS[0]!, proof: 'scripts/tests/a.test.ts: run reports the error' }, { finding: FINDINGS[1]!, proof: ' ' }])).answer(refused.lease())

    expect(unproved).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed', detail: unprovedFindingsLine(CARD, ANSWERED_HEAD, [FINDINGS[1]!]) } })
    expect(eventsOf(refused.bench.db, CARD_ANSWERED)).toEqual([])

    const proved = changesOnTheHead()
    const outcome = await proved.executor(answering(FINDINGS.map(finding => ({ finding: ` ${finding} `, proof: 'a test that fails without the fix' })))).answer(proved.lease())
    expect(outcome).toMatchObject({ kind: 'answered', head: ANSWERED_HEAD })
    expect(eventsOf(proved.bench.db, CARD_ANSWERED)).toHaveLength(1)
  })

  it('unproved findings are the given ones without a proof, read trimmed', () => {
    expect(unprovedFindings(FINDINGS, [])).toEqual(FINDINGS)
    expect(unprovedFindings([' a ', 'a', 'b'], [{ finding: 'a', proof: 'p' }])).toEqual(['b'])
    expect(unprovedFindings(['a'], [{ finding: 'a', proof: '' }])).toEqual(['a'])
    expect(unprovedFindings(['a', ''], [{ finding: 'a', proof: 'p' }])).toEqual([])
    expect(unprovedFindings(FINDINGS, undefined)).toEqual([])
  })
})

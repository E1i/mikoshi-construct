import type { Lease } from '../../core/lease.js'
import type { Answered, Answerer, AnswerRequest } from '../../nodes/answer/answerer.js'
import type { ShardDecider } from '../../nodes/answer/duties/index.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ANSWERED, CARD_STARTED, REVIEW_RECORDED, SHARD_ISSUED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor, findingsGivenByAReview, unprovedFindingsLine } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer, proofsIn, proofsPath, proofsRule, unprovedFindings } from '../../nodes/answer/answerer.js'
import { dryRunIn, keepDryRun } from '../../nodes/review/dry-run-record.js'
import { PrCloser } from '../../nodes/review/pr-close.js'
import { sayToOwnerChannel, USED_WORD } from '../../owner/channel.js'
import { decisionsAdder } from '../../policy/decisions/projection.js'
import { roundLimitDecisionOf } from '../../policy/round-limit-decision.js'
import { DECISIONS_SCOPE, decisionsInForceAt } from '../../policy/shards.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { ALLOW_MERGE_RECORD, ANSWER_SOURCE, HEAD_WORD, requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'
import { sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench, spendReviewRounds } from './merge-bench.js'

const PR = 1742
const CARD = PR + 100
const HEAD = sha('a')
const ANSWERED_HEAD = sha('b')
const SESSION = 'window-1'
const OWNER_MERGES = readFileSync('architecture/owner-merges.md', 'utf8')
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
  executor: (answerer: Answerer, shardDecider?: ShardDecider) => AnswerExecutor
  lease: () => Lease
}

function changesOnTheHead(underAShard = false): Changes {
  const bench = mergeBench()
  benches.push(bench)
  const home = rootDir('autonomy-rounds-answer-')
  const worktree = path.join(home, `mc-${CARD}`)
  mkdirSync(worktree)
  const ts = bench.clock.now().toISOString()
  bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
  bench.tick()
  if (underAShard)
    appendEvent(bench.db, { ts, type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:ws-1`, payload: { id: 'ws-1', by: 'owner', scope: DECISIONS_SCOPE, until: new Date(bench.clock.now().getTime() + 3_600_000).toISOString(), window: 1 }, legacy: false })
  appendEvent(bench.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(bench.db, { ts, type: REVIEW_RECORDED, actor: 'worker:review:review-1', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `${REVIEW_RECORDED}:${PR}:${HEAD}`, payload: { head: HEAD, verdict: 'changes', reviewer_session: 'reviewer-1', findings: FINDINGS }, legacy: false })
  bench.tick()
  queueTask(bench.db, ts, { queue: 'answer', cardId: CARD, pr: PR, head: HEAD })
  const trees: CardTreeTools = { home, exists: existsSync, branchOf: pr => `feat/card-${pr + 100}`, recreate: () => {}, bringTo: () => {} }
  return {
    bench,
    executor: (answerer, shardDecider) => new AnswerExecutor({ silentMs: SILENT_MS, db: bench.db, answerer, ownerMerges: () => OWNER_MERGES, clock: bench.clock.now, trees, dirty: () => false, liveSession: () => null, prepare: () => {}, mergeMain: () => () => ({ kind: 'inside', files: [] }), ...(shardDecider === undefined ? {} : { shardDecider, isolation: () => ({ level: 'partial', mechanism: 'claude-code-sandbox', gaps: [] }) }) }),
    lease: () => leaseNext(bench.db, bench.clock.now().toISOString(), 'answer', 'worker:answer:answer-1')!,
  }
}

const PROVED = FINDINGS.map(finding => ({ finding: ` ${finding} `, proof: 'a test that fails without the fix' }))

function answered(fields: Partial<Answered> = {}): Answered {
  return { session: 'card-session-1', resumed: true, before: HEAD, after: ANSWERED_HEAD, owner: null, ...fields }
}

function answeringInTurn(asked: AnswerRequest[], ...turns: Answered[]): Answerer {
  return async (request) => {
    asked.push(request)
    return turns.shift()!
  }
}

interface RealAnswer {
  prompts: string[]
  argv: string[][]
  published: number
  result: Answered
}

async function realAnswer(writesProofs: (prompt: string) => Record<string, string> | null, staleProofs = false): Promise<RealAnswer> {
  const dir = rootDir('autonomy-rounds-real-')
  const worktree = path.join(dir, 'tree')
  mkdirSync(worktree)
  const answers = path.join(dir, 'answers')
  mkdirSync(answers)
  const lease: Lease = { taskKey: `answer:${CARD}:${PR}:${HEAD}`, queue: 'answer', cardId: CARD, pr: PR, head: HEAD, leaseGen: 3, actor: 'worker:answer:answer-1' }
  if (staleProofs)
    writeFileSync(proofsPath(answers, 'card-session-1', lease.leaseGen), JSON.stringify({ 1: 'left by an earlier session', 2: 'left by an earlier session' }))
  const heads = [HEAD]
  const made: RealAnswer = { prompts: [], argv: [], published: 0, result: answered() }
  const answerer = claudeAnswerer(answers, {
    cardText: () => null,
    available: () => true,
    remoteHead: () => heads.at(-1)!,
    spawn: async (run) => {
      const prompt = run.argv.at(-1)!
      made.prompts.push(prompt)
      made.argv.push(run.argv)
      const proofs = writesProofs(prompt)
      if (proofs !== null)
        writeFileSync(proofsPath(answers, 'card-session-1', lease.leaseGen), JSON.stringify(proofs))
      return 0
    },
    newSession: () => 'new-session-1',
    publish: () => {
      made.published += 1
      heads.push(ANSWERED_HEAD)
    },
  })
  made.result = await answerer({ lease, source: { kind: 'changes', findings: FINDINGS, events: [], decisions: [] }, widened: null, card: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}` }, findingsToProve: FINDINGS })
  return made
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
    expect(window.decisions()).not.toContain(`at ${HEAD_WORD}:`)

    const lookalike = `continue-fixes PR #${PR} at headroom, and PR #${PR} at head-of-line`
    ownerSaid(window, lookalike)
    asked(window, { kind: 'decisions:add', text: `[owner] ${lookalike}`, from: ANSWER_SOURCE })
    expect(window.requests.run()).toEqual([expect.objectContaining({ kind: 'done' })])
    expect(window.decisions()).toContain(`[owner] ${lookalike}`)

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
    const changes = changesOnTheHead()
    const asked: AnswerRequest[] = []
    const partial = [{ finding: FINDINGS[0]!, proof: 'scripts/tests/a.test.ts: run reports the error' }, { finding: FINDINGS[1]!, proof: ' ' }]
    const answerer = answeringInTurn(asked, answered({ after: HEAD, proofs: partial }), answered({ after: HEAD }), answered({ proofs: PROVED }))

    expect(await changes.executor(answerer).answer(changes.lease())).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed', detail: unprovedFindingsLine(CARD, { before: HEAD, after: HEAD }, [FINDINGS[1]!]) } })
    expect(unprovedFindingsLine(CARD, { before: HEAD, after: HEAD }, [FINDINGS[1]!])).toContain(`the bus pushed nothing from it, so the answer goes again on ${HEAD}`)
    expect(await changes.executor(answerer).answer(changes.lease())).toMatchObject({ kind: 'denied', denial: { detail: unprovedFindingsLine(CARD, { before: HEAD, after: HEAD }, FINDINGS) } })
    expect(eventsOf(changes.bench.db, CARD_ANSWERED)).toEqual([])

    expect(await changes.executor(answerer).answer(changes.lease())).toMatchObject({ kind: 'answered', head: ANSWERED_HEAD })
    expect(eventsOf(changes.bench.db, CARD_ANSWERED)).toHaveLength(1)
    expect(asked.map(request => request.findingsToProve)).toEqual([FINDINGS, FINDINGS, FINDINGS])
    expect(unprovedFindingsLine(CARD, { before: HEAD, after: ANSWERED_HEAD }, FINDINGS)).toContain(`its head ${ANSWERED_HEAD} was pushed without them`)
  })

  it('a session restarted at the context warn is asked for the proofs again', async () => {
    const changes = changesOnTheHead()
    const asked: AnswerRequest[] = []
    const answerer = answeringInTurn(asked, answered({ after: HEAD, atContextWarn: true }), answered({ proofs: PROVED }))

    expect(await changes.executor(answerer).answer(changes.lease())).toMatchObject({ kind: 'answered', head: ANSWERED_HEAD })
    expect(asked.map(request => [request.fresh, request.findingsToProve])).toEqual([[false, FINDINGS], [true, FINDINGS]])
  })

  it('a round the window decides under a shard still owes a proof of every finding', async () => {
    const question = 'may the card also touch contract/factory-permissions.json?'
    const decide: ShardDecider = () => ({ answer: 'the one the finding names' })
    const unproved = changesOnTheHead(true)
    const asked: AnswerRequest[] = []
    const outcome = await unproved.executor(answeringInTurn(asked, answered({ after: HEAD, owner: question }), answered()), decide).answer(unproved.lease())

    expect(asked.map(request => request.findingsToProve)).toEqual([FINDINGS, FINDINGS])
    expect(outcome).toMatchObject({ kind: 'denied', denial: { detail: unprovedFindingsLine(CARD, { before: HEAD, after: ANSWERED_HEAD }, FINDINGS) } })
    expect(eventsOf(unproved.bench.db, CARD_ANSWERED)).toEqual([])

    const proved = changesOnTheHead(true)
    expect(await proved.executor(answeringInTurn([], answered({ after: HEAD, owner: question }), answered({ proofs: PROVED })), decide).answer(proved.lease())).toMatchObject({ kind: 'answered' })
  })

  it('the answerer asks the session again for missing proofs and publishes nothing until every finding is proved', async () => {
    const proofsFile = (made: RealAnswer): string => made.argv[0]!.find(arg => arg.includes('Edit(') && arg.includes('.proofs.json')) ?? ''
    const late = await realAnswer(prompt => prompt.includes('These findings have none yet') ? { 1: 'a.test.ts fails without the fix', 2: 'the empty list test' } : null)
    expect(late.prompts).toHaveLength(2)
    expect(late.prompts[1]).toContain(`- ${FINDINGS[0]}`)
    expect(late.published).toBe(1)
    expect(late.result).toMatchObject({ after: ANSWERED_HEAD, proofs: [{ finding: FINDINGS[0], proof: 'a.test.ts fails without the fix' }, { finding: FINDINGS[1], proof: 'the empty list test' }] })
    expect(proofsFile(late)).toContain(proofsPath('', 'card-session-1', 3).slice(1))

    const never = await realAnswer(() => ({ 1: 'only the first' }))
    expect(never.prompts).toHaveLength(2)
    expect(never.prompts[1]).not.toContain(`- ${FINDINGS[0]}`)
    expect(never.prompts[1]).toContain(`- ${FINDINGS[1]}`)
    expect(never.published).toBe(0)
    expect(never.result).toMatchObject({ before: HEAD, after: HEAD, proofs: [{ finding: FINDINGS[0], proof: 'only the first' }] })

    const stale = await realAnswer(() => null, true)
    expect(stale.published).toBe(0)
    expect(stale.result.proofs).toEqual([])
  })

  it('unproved findings are the given ones without a proof, read trimmed', () => {
    expect(unprovedFindings(FINDINGS, [])).toEqual(FINDINGS)
    expect(unprovedFindings([' a ', 'a', 'b'], [{ finding: 'a', proof: 'p' }])).toEqual(['b'])
    expect(unprovedFindings(['a'], [{ finding: 'a', proof: '' }])).toEqual(['a'])
    expect(unprovedFindings(['a', ''], [{ finding: 'a', proof: 'p' }])).toEqual([])
    expect(unprovedFindings(FINDINGS, undefined)).toEqual(FINDINGS)
  })

  it('the answer session is asked for a proof per numbered finding, and the answerer reads them back', () => {
    const dir = rootDir('autonomy-rounds-proofs-')
    const file = proofsPath(dir, 'session-1', 2)
    const changes = { kind: 'changes' as const, findings: FINDINGS, events: [], decisions: [] }

    expect(proofsRule(FINDINGS, file)).toEqual([expect.stringContaining(file) as unknown, `1. ${FINDINGS[0]}`, `2. ${FINDINGS[1]}`])
    expect(proofsRule([], file)).toEqual([])
    expect(findingsGivenByAReview(changes)).toEqual(FINDINGS)
    expect(findingsGivenByAReview({ ...changes, reentry: true })).toEqual([])
    expect(findingsGivenByAReview({ kind: 'ci', failedChecks: [], events: [], decisions: [] })).toEqual([])
    expect(findingsGivenByAReview(null)).toEqual([])
    expect(proofsIn(file, FINDINGS)).toEqual([])

    writeFileSync(file, JSON.stringify({ 1: 'scripts/tests/a.test.ts fails without the fix', 2: 7 }))
    expect(proofsIn(file, FINDINGS)).toEqual([{ finding: FINDINGS[0], proof: 'scripts/tests/a.test.ts fails without the fix' }])
    writeFileSync(file, 'not json')
    expect(proofsIn(file, FINDINGS)).toEqual([])
    writeFileSync(file, JSON.stringify(['a proof']))
    expect(proofsIn(file, FINDINGS)).toEqual([])
  })
})

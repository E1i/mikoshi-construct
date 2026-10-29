import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/answer-executor.js'
import type { Answerer, AnswerRequest } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { IsolationReader } from '../../ports/isolation.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED, REVIEW_RECORDED, SHARD_DECIDED, SHARD_ISSUED, WITNESS_RECORDED } from '../../core/events.js'
import { prBodySha, taskKey } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { answerCandidates, changesRoundsOf, mergeCandidates, queueTask, reentryLimitWaitText, REVIEW_ROUNDS, witnessCandidates } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { importJournal } from '../../intake/import.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { answerPrompt } from '../../nodes/answer/answerer.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { earlierVerdict } from '../../nodes/review/review-executor.js'
import { ReviewWorker } from '../../nodes/review/review-worker.js'
import { reviewPrompt } from '../../nodes/review/reviewer.js'
import { DECISIONS_SCOPE } from '../../policy/shards.js'
import { NetWatch, TICK_MS } from '../../ports/netwatch.js'
import { BusTick } from '../../supervisor/run.js'
import { cardBody, Clock, FakeGitHub, sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'
import { detectReview } from './review-detection.js'

const OWNER_MERGES = readFileSync('architecture/owner-merges.md', 'utf8')
const OWNER_QUESTION = 'may the card also touch .claude/settings.json?'
const NOW = '2026-10-29T12:00:00.000Z'
const GATE = { prepush: [], handoffWrite: null, codeMatrix: null }
const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function reviewBus(): { db: DatabaseSync, gitHub: FakeGitHub, clock: Clock, tick: () => void } {
  const db = openBus(path.join(scratch('bus-reviewloop-'), 'bus.db'))
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const busTick = new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now)
  let first = true
  const tick = (): void => {
    if (!first)
      clock.advance(TICK_MS)
    first = false
    busTick.run()
    detectReview({ db, gitHub, clock })
  }
  return { db, gitHub, clock, tick }
}

function intakeLine(cardId: number, bodySha: string): string {
  return JSON.stringify({ event: 'intake', task: String(cardId), card: `#${cardId} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —`, confirmation: 'auto', corrections: [], bodySha, source: 'admit', ts: '2026-10-11T14:00:00.000Z' })
}

function leaseOf(pr: number, head: string, taskKeyText: string): Lease {
  return { taskKey: taskKeyText, queue: 'review', cardId: pr + 100, pr, head, leaseGen: 1, actor: 'worker:review:worker-1' }
}

function answerTasksOf(db: DatabaseSync, cardId: number): { task_key: string, state: string }[] {
  return db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'answer' AND card_id = ? AND state IN ('queued', 'leased') ORDER BY id`).all(cardId) as { task_key: string, state: string }[]
}

function questionUnderShard(made: ReturnType<typeof mergeBench>, answerer: Answerer, dirty: () => boolean): () => Promise<AnswerOutcome> {
  const trees = scratch('bus-reviewloop-shard-')
  const worktree = path.join(trees, 'mc-905')
  mkdirSync(worktree)
  const now = made.clock.now()
  const ts = now.toISOString()
  appendEvent(made.db, { ts, type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:ws-1`, payload: { id: 'ws-1', by: 'Eli', scope: DECISIONS_SCOPE, until: new Date(now.getTime() + 3_600_000).toISOString(), window: 1 }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 905, pr: null, head: null, dedupeKey: `${CARD_STARTED}:905`, payload: { session: 'card-session-1', worktree, branch: 'feat/card-905', base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: 905, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:905`, payload: { reason: 'question.agent', detail: 'a question on card #905' }, legacy: false })
  const stop = Number((made.db.prepare(`SELECT max(id) AS id FROM events WHERE type = ?`).get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, ts, { queue: 'answer', cardId: 905, stop })
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees, isolation: () => ({ level: 'partial', mechanism: 'claude-code-sandbox', gaps: [] }), dirty })
  return async () => executor.answer(leaseNext(made.db, ts, 'answer', 'worker:answer:worker-1')!)
}

describe('the review loop', () => {
  it('a later round reports only earlier findings and regressions', () => {
    const db = openBus(':memory:')
    const finding = 'scripts/core/queue.ts: the candidate skips a leased card'
    const first = taskKey({ queue: 'review', cardId: 1150, pr: 1050, head: sha('a'), input: { prBody: prBodySha(cardBody(1050)), cardBody: 'aaaa1111' } })
    const again = taskKey({ queue: 'review', cardId: 1150, pr: 1050, head: sha('a'), input: { prBody: prBodySha(cardBody(1050)), cardBody: 'bbbb2222' } })
    appendEvent(db, { ts: NOW, type: REVIEW_RECORDED, actor: 'worker:review:worker-1', cardId: 1150, pr: 1050, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:${first}:1`, payload: { head: sha('a'), verdict: 'changes', reviewer_session: 'reviewer-1', findings: [finding] }, legacy: false })

    const lease = leaseOf(1050, sha('a'), again)
    expect(earlierVerdict(db, lease)).toEqual({ head: sha('a'), verdict: 'changes', findings: [finding] })
    expect(earlierVerdict(db, leaseOf(1050, sha('a'), first))).toBeNull()
    const prompt = reviewPrompt(lease, { depth: 'diff', round: 'again', why: 'a re-review', since: sha('a'), findings: [finding] }, '/tree', '/verdict.json')
    expect(prompt).toContain('Report no new finding against the code')
    expect(prompt).toContain(`Earlier finding: ${finding}`)
    db.close()
  })

  it('one answer task per card across heads', () => {
    const made = mergeBench()
    made.gitHub.open({ number: 1060, review: 'failure' })
    made.tick()
    const leased = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!
    expect(leased.cardId).toBe(1160)

    made.gitHub.open({ number: 1060, head: sha('b'), required: 'failure', failed: ['lint'] })
    made.tick()
    made.tick()

    expect(answerTasksOf(made.db, 1160)).toEqual([{ task_key: leased.taskKey, state: 'leased' }])
    expect(answerCandidates(made.db, made.clock.now().toISOString()).filter(task => task.cardId === 1160)).toEqual([])
    made.close()
  })

  it('a card on review when the cycle changes finishes without intervention', async () => {
    const { db, gitHub, clock, tick } = reviewBus()
    const verdicts: ('changes' | 'pass')[] = ['changes', 'pass']
    const worker = new ReviewWorker({
      isolation: sandboxed,
      db,
      gitHub: gitHub.client,
      publish: (status) => {
        gitHub.pulls.get(931)!.review = status.state
      },
      reviewer: async () => ({ verdict: verdicts.shift()!, findings: [], session: 'reviewer-1' }),
      plan: () => fullReview('a fixed plan'),
      clock: clock.now,
      session: 'worker-1',
    })
    gitHub.open({ number: 931, body: cardBody(931) })
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes' })
    tick()
    importJournal(db, intakeLine(1031, '0123abcd4567ef89'))
    tick()
    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'pass' })
    tick()
    expect(gitHub.pulls.get(931)!.review).toBe('success')
    db.close()
  })

  it('a red CI on a card PR becomes an answer task with the failure log and no owner question', () => {
    const made = mergeBench()
    made.gitHub.open({ number: 1061 })
    made.tick()
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: WITNESS_RECORDED, actor: 'worker:witness:worker-1', cardId: 1161, pr: 1061, head: sha('a'), dedupeKey: `${WITNESS_RECORDED}:red-1061`, payload: { head: sha('a'), base: sha('1'), cardBody: 'x', verdict: 'red', detail: 'W1 exited 1' }, legacy: false })
    made.tick()
    made.tick()

    expect(answerTasksOf(made.db, 1161)).toHaveLength(1)
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([])
    const lease: Lease = { taskKey: answerTasksOf(made.db, 1161)[0]!.task_key, queue: 'answer', cardId: 1161, pr: 1061, head: sha('a'), leaseGen: 1, actor: 'worker:answer:worker-1' }
    const request: AnswerRequest = { lease, source: { kind: 'ci', failedChecks: ['vitest 2/4'], events: [] }, widened: null, card: { session: 's', worktree: '/tree', branch: 'feat/card-1161' } }
    const log = 'FAIL scripts/tests/bus/queue.test.ts > the queue > expected 1 to be 2'
    const prompt = answerPrompt(request, '/answers/s.1.owner.txt', null, GATE, undefined, log)
    expect(prompt).toContain(log)
    expect(prompt).not.toContain('gh run view --log-failed')
    made.close()
  })

  it('a spent round limit asks the owner and never merges', () => {
    const made = mergeBench()
    made.gitHub.open({ number: 1062, review: 'success' })
    made.tick()
    for (const [at, from] of [sha('a'), sha('b'), sha('c')].entries())
      appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ANSWERED, actor: 'worker:answer:worker-1', cardId: 1162, pr: 1062, head: from, dedupeKey: `${CARD_ANSWERED}:reentry-${at}`, payload: { session: 's', worktree: '/tree', resumed: true, source: 'ci', from, to: sha(String(at + 1)), reentry: true }, legacy: false })
    made.tick()
    made.tick()

    expect(changesRoundsOf(made.db, 1062)).toBeGreaterThanOrEqual(REVIEW_ROUNDS)
    expect(eventsOf(made.db, OWNER_WAIT_OPENED).map(wait => wait.text)).toEqual([reentryLimitWaitText(1162, 1062)])
    expect(mergeCandidates(made.db, made.clock.now().toISOString()).filter(task => task.pr === 1062)).toEqual([])
    made.close()
  })

  it('a card with no PR gets a witness task on main', () => {
    const db = openBus(':memory:')
    const text = parkingFileText({ card: '#1170 done-on-main [implement/netwatch/S/cheap/auto] · depends — · blocks —', branch: 'feat/done-on-main', touches: ['done.txt'], continue: 'stop', who: 'shift', body: 'Write done.txt.\n\nWitnesses:\n- `test -f done.txt` exits 0; red on main' })
    appendEvent(db, { ts: NOW, type: 'main.advanced', actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: 'main.advanced:m', payload: { sha: sha('d'), touches_mechanics: false }, legacy: false })
    appendEvent(db, { ts: NOW, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: 1170, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:1170`, payload: { card: '#1170', lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
    reduce(db)

    expect(witnessCandidates(db, NOW).filter(task => task.cardId === 1170)).toMatchObject([{ queue: 'witness', cardId: 1170, head: sha('d') }])
    db.close()
  })

  it('a shard decision reaches the answer session that asked it', async () => {
    const made = mergeBench()
    const requests: AnswerRequest[] = []
    const asked = questionUnderShard(made, async (request) => {
      requests.push(request)
      return { session: 'card-session-1', resumed: true, before: sha('a'), after: sha('a'), owner: requests.length === 1 ? OWNER_QUESTION : null }
    }, () => false)

    expect(await asked()).toMatchObject({ kind: 'decided' })
    expect(eventsOf(made.db, SHARD_DECIDED)).toHaveLength(1)
    expect(requests).toHaveLength(2)
    expect(requests[1]!.card.session).toBe('card-session-1')
    expect(requests[1]!.source).toMatchObject({ kind: 'question', detail: expect.stringContaining(OWNER_QUESTION) as unknown })
    made.close()
  })

  it('an answer that pushed nothing over a dirty card tree is not completed', async () => {
    const made = mergeBench()
    const asked = questionUnderShard(made, async () => ({ session: 'card-session-1', resumed: true, before: sha('a'), after: sha('a'), owner: null }), () => true)

    expect(await asked()).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'answer_failed' } })
    expect(answerTasksOf(made.db, 905)).toEqual([expect.objectContaining({ state: 'queued' })])
    made.close()
  })
})

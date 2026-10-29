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
import { CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED, QUESTION_OWNER, REVIEW_RECORDED, SCOPE_WIDENED, SHARD_DECIDED, SHARD_ISSUED, WITNESS_RECORDED } from '../../core/events.js'
import { prBodySha, taskKey } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { answerCandidates, changesRoundsOf, mergeCandidates, queueTask, reentryLimitWaitText, REVIEW_ROUNDS, witnessCandidates } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { importJournal } from '../../intake/import.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { answerPrompt, AnswerWithdrawn, claudeAnswerer } from '../../nodes/answer/answerer.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { AMEND_KEEPS_CHANGES, earlierVerdict } from '../../nodes/review/review-executor.js'
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

function reviewWorker(db: DatabaseSync, gitHub: FakeGitHub, clock: Clock, pr: number, review: () => { verdict: 'changes' | 'pass', findings: string[] }): ReviewWorker {
  return new ReviewWorker({
    isolation: sandboxed,
    db,
    gitHub: gitHub.client,
    publish: (status) => {
      gitHub.pulls.get(pr)!.review = status.state
    },
    reviewer: async () => ({ ...review(), session: 'reviewer-1' }),
    plan: () => fullReview('a fixed plan'),
    clock: clock.now,
    session: 'worker-1',
  })
}

function queuedReviewKey(db: DatabaseSync): string {
  return (db.prepare(`SELECT task_key FROM tasks WHERE queue = 'review' AND state = 'queued'`).get() as { task_key: string }).task_key
}

function earlierRound(db: DatabaseSync, key: string, round: number, verdict: 'changes' | 'pass', findings: string[]): void {
  appendEvent(db, { ts: NOW, type: REVIEW_RECORDED, actor: 'worker:review:worker-1', cardId: 1031, pr: 931, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:${key}:${round}`, payload: { head: sha('a'), verdict, reviewer_session: 'reviewer-0', findings }, legacy: false })
}

function lastRecorded(db: DatabaseSync): Record<string, unknown> {
  return eventsOf(db, REVIEW_RECORDED).at(-1)!
}

function answerTasksOf(db: DatabaseSync, cardId: number): { task_key: string, state: string }[] {
  return db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'answer' AND card_id = ? AND state IN ('queued', 'leased') ORDER BY id`).all(cardId) as { task_key: string, state: string }[]
}

function questionUnderShard(made: ReturnType<typeof mergeBench>, answerer: Answerer, dirty: () => boolean, widen: string[] = []): () => Promise<AnswerOutcome> {
  const trees = scratch('bus-reviewloop-shard-')
  const worktree = path.join(trees, 'mc-905')
  mkdirSync(worktree)
  const now = made.clock.now()
  const ts = now.toISOString()
  appendEvent(made.db, { ts, type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:ws-1`, payload: { id: 'ws-1', by: 'Eli', scope: DECISIONS_SCOPE, until: new Date(now.getTime() + 3_600_000).toISOString(), window: 1 }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 905, pr: null, head: null, dedupeKey: `${CARD_STARTED}:905`, payload: { session: 'card-session-1', worktree, branch: 'feat/card-905', base: sha('1') }, legacy: false })
  if (widen.length > 0) {
    const text = parkingFileText({ card: '#905 widened [implement/netwatch/S/cheap/auto] · depends — · blocks —', branch: 'feat/card-905', touches: ['scripts/core/queue.ts', ...widen], continue: 'stop', who: 'shift', body: 'Answer it.' })
    appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: 905, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:905`, payload: { card: '#905', lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
    reduce(made.db)
  }
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: 905, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:905`, payload: { reason: 'question.agent', detail: 'a question on card #905', ...(widen.length > 0 ? { widen } : {}) }, legacy: false })
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

  it('a leased answer of a pull request that closes is superseded', () => {
    const made = mergeBench()
    made.gitHub.open({ number: 1063, review: 'failure' })
    made.tick()
    const leased = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!
    made.gitHub.close(1063, false)
    made.tick()
    made.tick()

    expect(answerTasksOf(made.db, leased.cardId)).toEqual([])
    made.close()
  })

  it('an answer session whose task is no longer held is stopped', async () => {
    const worktree = scratch('bus-reviewloop-withdrawn-')
    const lease: Lease = { taskKey: 'answer:1164:1064', queue: 'answer', cardId: 1164, pr: 1064, head: sha('a'), leaseGen: 1, actor: 'worker:answer:worker-1' }
    const spawned: boolean[] = []
    const answerer = claudeAnswerer(scratch('bus-reviewloop-answers-'), {
      cardText: () => null,
      available: () => true,
      remoteHead: () => sha('a'),
      newSession: () => 'card-session-1',
      publish: () => {},
      held: () => false,
      spawn: async () => {
        spawned.push(true)
        return 0
      },
    })

    await expect(answerer({ lease, source: { kind: 'changes', findings: ['a finding'], events: [] }, widened: null, card: { session: 'card-session-1', worktree, branch: 'feat/card-1164' } })).rejects.toBeInstanceOf(AnswerWithdrawn)
    expect(spawned).toEqual([])
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

  it('a pass on the same head under the same pull request and card bodies keeps the changes verdict', async () => {
    const { db, gitHub, clock, tick } = reviewBus()
    const worker = reviewWorker(db, gitHub, clock, 931, () => ({ verdict: 'pass', findings: [] }))
    gitHub.open({ number: 931, body: cardBody(931) })
    tick()
    earlierRound(db, queuedReviewKey(db), 0, 'changes', ['a finding'])

    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes' })
    expect(lastRecorded(db)).toMatchObject({ verdict: 'changes', findings: [AMEND_KEEPS_CHANGES] })
    db.close()
  })

  it('a finding closed on a head is not reopened on that same head', async () => {
    const { db, gitHub, clock, tick } = reviewBus()
    const reviews = [{ verdict: 'changes' as const, findings: ['closed earlier'] }, { verdict: 'changes' as const, findings: ['closed earlier', 'still open'] }]
    const worker = reviewWorker(db, gitHub, clock, 931, () => reviews.shift()!)
    gitHub.open({ number: 931, body: cardBody(931) })
    tick()
    const other = taskKey({ queue: 'review', cardId: 1031, pr: 931, head: sha('a'), input: { prBody: prBodySha(cardBody(931)), cardBody: 'eeee5555' } })
    earlierRound(db, other, 1, 'changes', ['closed earlier', 'still open'])
    earlierRound(db, other, 2, 'changes', ['still open'])

    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'pass' })
    expect(lastRecorded(db)).toMatchObject({ verdict: 'pass', findings: [] })
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

  function redCiAnswerBench(cardId: number, pr: number, review: { review?: 'failure' } = {}): { made: ReturnType<typeof mergeBench>, prompts: string[], logsRead: string[], answer: () => Promise<AnswerOutcome> } {
    const made = mergeBench()
    const worktree = scratch('bus-red-ci-tree-')
    const prompts: string[] = []
    const logsRead: string[] = []
    const heads = [sha('a'), sha('e')]
    const answerer = claudeAnswerer(scratch('bus-red-ci-answers-'), {
      cardText: () => null,
      available: () => true,
      remoteHead: () => heads.shift() ?? null,
      spawn: async (run) => {
        prompts.push(run.argv.at(-1)!)
        return 0
      },
      newSession: () => 'new-session-1',
      publish: () => {},
      ciLog: (_card, head) => {
        logsRead.push(head)
        return 'FAIL scripts/tests/bus/queue.test.ts > the queue > expected 1 to be 2'
      },
    })
    const cardTrees: CardTreeTools = { home: worktree, exists: existsSync, branchOf: () => `feat/card-${cardId}`, recreate: () => {}, bringTo: () => {} }
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees })
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${cardId}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${cardId}`, base: sha('1') }, legacy: false })
    made.gitHub.open({ number: pr, required: 'failure', failed: ['vitest 4/4'], ...review })
    const answer = async (): Promise<AnswerOutcome> => {
      made.tick()
      made.tick()
      const lease = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!
      return executor.answer(lease)
    }
    return { made, prompts, logsRead, answer }
  }

  it('an answer on a PR with review changes and a red CI carries the findings and the failed-job log', async () => {
    const { made, prompts, logsRead, answer } = redCiAnswerBench(1209, 1109, { review: 'failure' })
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1209, pr: 1109, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:1109`, payload: { head: sha('a'), verdict: 'changes', reviewer_session: 'reviewer-1', findings: ['the source is one kind'] }, legacy: false })

    expect(await answer()).toMatchObject({ kind: 'answered' })
    expect(logsRead).toEqual([sha('a')])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('- the source is one kind')
    expect(prompts[0]).toContain('The failed checks: vitest 4/4.')
    expect(prompts[0]).toContain('FAIL scripts/tests/bus/queue.test.ts > the queue > expected 1 to be 2')
    made.close()
  })

  it('an answer on a PR with a red witness and a red CI carries the witness and the failed-job log', async () => {
    const { made, prompts, logsRead, answer } = redCiAnswerBench(1210, 1110)
    made.tick()
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: WITNESS_RECORDED, actor: 'worker:witness:worker-1', cardId: 1210, pr: 1110, head: sha('a'), dedupeKey: `${WITNESS_RECORDED}:red-1110`, payload: { head: sha('a'), base: sha('1'), cardBody: 'x', verdict: 'red', detail: 'W1 exited 1' }, legacy: false })

    expect(await answer()).toMatchObject({ kind: 'answered' })
    expect(logsRead).toEqual([sha('a')])
    expect(prompts[0]).toContain(`the card's witness is red on ${sha('a')}: W1 exited 1`)
    expect(prompts[0]).toContain('The failed checks: vitest 4/4.')
    expect(prompts[0]).toContain('FAIL scripts/tests/bus/queue.test.ts > the queue > expected 1 to be 2')
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
    expect(witnessCandidates(db, NOW).filter(task => task.cardId === 1170)).toEqual([])

    appendEvent(db, { ts: NOW, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 1170, pr: null, head: null, dedupeKey: `${CARD_STARTED}:1170`, payload: { session: 's', worktree: '/tree', branch: 'feat/done-on-main', base: sha('1') }, legacy: false })
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

  it('a question asked again after a shard decision goes to the owner', async () => {
    const made = mergeBench()
    const again = 'may the card also touch .claude/agents/review.md?'
    const asked = questionUnderShard(made, async () => ({ session: 'card-session-1', resumed: true, before: sha('a'), after: sha('a'), owner: again }), () => false)

    expect(await asked()).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: expect.stringContaining(again) as unknown })
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toHaveLength(1)
    made.close()
  })

  it('a widen asked with a shard-decided question is recorded when the decided session pushes', async () => {
    const made = mergeBench()
    let calls = 0
    const asked = questionUnderShard(made, async () => {
      calls += 1
      return { session: 'card-session-1', resumed: true, before: sha('a'), after: calls === 1 ? sha('a') : sha('b'), owner: calls === 1 ? OWNER_QUESTION : null }
    }, () => false, ['scripts/core/lease.ts'])

    const outcome = await asked()
    expect(outcome).toMatchObject({ kind: 'answered', head: sha('b') })
    expect(eventsOf(made.db, SCOPE_WIDENED)).toHaveLength(1)
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

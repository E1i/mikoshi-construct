import type { AnswerOutcome } from '../../bus/answer-executor.js'
import type { AnswerRun } from '../../bus/answerer.js'
import type { CardTreeTools } from '../../bus/card-tree.js'
import type { Queue } from '../../bus/identifiers.js'
import type { Lease } from '../../bus/lease.js'
import type { StoredEvent } from '../../bus/stored.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnswerExecutor, SCOPE_WIDENED } from '../../bus/answer-executor.js'
import { answerSourceOf, NO_RECORDED_SESSION } from '../../bus/answer-source.js'
import { runAnswerWorker } from '../../bus/answer-worker.js'
import { claudeAnswerer, ownerQuestionPath, projectDirOf } from '../../bus/answerer.js'
import { readBoard } from '../../bus/board.js'
import { REVIEW_RECORDED } from '../../bus/card-automaton.js'
import { appendEvent } from '../../bus/db.js'
import { recordDecision } from '../../bus/decisions.js'
import { taskKey } from '../../bus/identifiers.js'
import { importJournal } from '../../bus/import.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, inboxText, ownerInbox, POLICY_DENIED } from '../../bus/inbox.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { completeTask, expireLeases, failTask, LEASE_MS, leaseNext } from '../../bus/lease.js'
import { BOARD_ALARM, FAILURES_TO_STOP, identityOf, queueTask, TASK_ENQUEUED, TASK_FOLDS, TASK_REQUEUED } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { REJECTED } from '../../bus/rejection.js'
import { SHARD_ISSUED } from '../../bus/shards.js'
import { Rejection } from '../../bus/stored.js'
import { moduleOf, wideningOf } from '../../bus/widening.js'
import { sha } from './github-fake.js'
import { eventCount, eventsOf, mergeBench, taskState } from './merge-bench.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const OWNER_MERGES = readFileSync('architecture/owner-merges.md', 'utf8')
const CARD_SESSION = 'card-session-1'
const PUSHED = sha('e')
const answer = (cardId: number, pr?: number, head?: string): string => taskKey({ queue: 'answer', cardId, pr, head })

interface Tools {
  runs: AnswerRun[]
  available: boolean
  heads: (string | null)[]
  during: () => void
  published: { branch: string, commitMessage: string }[]
  recreated: { worktree: string, branch: string }[]
  recreating: () => void
}

function answerBench() {
  const bench = mergeBench()
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-trees-'))
  const treeOf = (cardId: number): string => path.join(trees, `mc-${cardId}`)
  const home = path.join(trees, 'worktrees')
  const answers = path.join(trees, 'answers')
  const tools: Tools = { runs: [], available: true, heads: [sha('a'), PUSHED], during: () => {}, published: [], recreated: [], recreating: () => {} }
  const cardTrees: CardTreeTools = {
    home,
    exists: existsSync,
    branchOf: pr => `feat/card-${pr + 100}`,
    recreate: (worktree, branch) => {
      tools.recreating()
      mkdirSync(worktree, { recursive: true })
      tools.recreated.push({ worktree, branch })
    },
    bringTo: () => {},
  }
  const answerer = claudeAnswerer(answers, {
    cardText: () => null,
    available: card => tools.available && card.session !== NO_RECORDED_SESSION,
    remoteHead: () => tools.heads.shift() ?? null,
    spawn: async (run) => {
      tools.runs.push(run)
      tools.during()
      return 0
    },
    newSession: () => 'new-session-1',
    publish: (card, commitMessage) => {
      tools.published.push({ branch: card.branch, commitMessage })
    },
  })
  const executor = new AnswerExecutor({ db: bench.db, answerer, ownerMerges: () => OWNER_MERGES, clock: bench.clock.now, trees: cardTrees })
  const ts = (): string => bench.clock.now().toISOString()
  return {
    ...bench,
    tools,
    treeOf,
    home,
    answers,
    startLine: (line: Record<string, unknown>): void => {
      if (typeof line.worktree === 'string')
        mkdirSync(line.worktree, { recursive: true })
      importJournal(bench.db, JSON.stringify({ event: 'path', path: 'cheap', started: ts(), ...line, ts: ts() }))
    },
    question: (cardId: number, pr?: number, head?: string): string => {
      const { stop } = bench.db.prepare(`SELECT max(id) AS stop FROM events WHERE type = '${CARD_STOPPED}' AND card_id = ?`).get(cardId) as { stop: number }
      return `${answer(cardId, pr, head)}:stop-${stop}`
    },
    leaseAnswer: (actor = 'worker:answer:worker-1'): Lease | null => leaseNext(bench.db, ts(), 'answer', actor),
    answer: (lease: Lease): Promise<AnswerOutcome> => executor.answer(lease),
    started: (cardId: number, session = CARD_SESSION): void => {
      mkdirSync(treeOf(cardId), { recursive: true })
      appendEvent(bench.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
      appendEvent(bench.db, { ts: ts(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${cardId}:${session}`, payload: { session, worktree: treeOf(cardId), branch: `feat/card-${cardId}`, base: sha('1') }, legacy: false })
    },
    stopped: (cardId: number, payload: object, pr: number | null = null, head: string | null = null): void => {
      appendEvent(bench.db, { ts: ts(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId, pr, head, dedupeKey: `${CARD_STOPPED}:${cardId}:${JSON.stringify(payload)}`, payload, legacy: false })
    },
    reviewed: (pr: number, findings: string[]): void => {
      appendEvent(bench.db, { ts: ts(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: pr + 100, pr, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:${pr}`, payload: { head: sha('a'), verdict: 'changes', reviewer_session: 'reviewer-1', findings }, legacy: false })
    },
    close: (): void => {
      bench.close()
      rmSync(trees, { recursive: true, force: true })
    },
  }
}

describe('the answer queue', () => {
  it('a question.agent stop and a changes verdict on the current head enter answer and a question.owner stop does not', () => {
    const bench = answerBench()
    bench.started(900)
    bench.stopped(900, { reason: 'question.agent', detail: 'which reader owns the session id?' })
    bench.started(901)
    bench.stopped(901, { reason: 'question.owner', detail: 'may the card touch architecture/owner-merges.md?' })
    bench.stopped(902, { reason: 'question.agent', detail: 'answered already' })
    bench.started(902)
    bench.gitHub.open({ number: 990, review: 'failure' })
    bench.gitHub.open({ number: 991, review: 'success', head: sha('b') })
    bench.gitHub.open({ number: 992, review: 'failure', head: sha('c') })
    bench.stopped(1092, { reason: 'question.owner', detail: 'the owner decides' }, 992, sha('c'))
    bench.tick()

    expect(taskState(bench.db, bench.question(900))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    expect(taskState(bench.db, answer(1090, 990, sha('a')))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    const keys = (bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer' ORDER BY task_key`).all() as { task_key: string }[]).map(row => row.task_key)
    expect(keys).toEqual([answer(1090, 990, sha('a')), bench.question(900)])
    expect(ownerInbox(bench.db).map(line => line.card_id)).toEqual([901, 1092])
    expect(bench.leaseAnswer()).toMatchObject({ taskKey: bench.question(900), queue: 'answer', pr: null, head: null, leaseGen: 1 })
    expect(bench.leaseAnswer()).toMatchObject({ taskKey: answer(1090, 990, sha('a')), leaseGen: 1 })

    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('an answer round resumes the card session with the same session id', async () => {
    const bench = answerBench()
    bench.started(1093)
    bench.gitHub.open({ number: 993, review: 'failure' })
    bench.tick()

    const outcome = await bench.answer(bench.leaseAnswer()!)

    expect(outcome).toEqual({ kind: 'answered', taskKey: answer(1093, 993, sha('a')), session: CARD_SESSION, resumed: true, head: PUSHED })
    const [run] = bench.tools.runs
    expect(run!.cwd).toBe(bench.treeOf(1093))
    expect(run!.argv.slice(-3, -1)).toEqual(['--resume', CARD_SESSION])
    expect(run!.argv).not.toContain('--session-id')
    expect(eventsOf(bench.db, CARD_ANSWERED)).toEqual([{ session: CARD_SESSION, resumed: true, source: 'changes', from: sha('a'), to: PUSHED }])
    expect(taskState(bench.db, answer(1093, 993, sha('a'))).state).toBe('completed')
    bench.close()
  })

  it('an answer session asks for no commit or push, and the bus commits and pushes its tree after it ends', async () => {
    const bench = answerBench()
    bench.started(1098)
    bench.gitHub.open({ number: 998, review: 'failure' })
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', head: PUSHED })
    const prompt = bench.tools.runs[0]!.argv.at(-1)!
    expect(prompt).toContain('Do not commit and do not push')
    expect(prompt).not.toContain('commit and push to')
    expect(bench.tools.published).toEqual([{ branch: 'feat/card-1098', commitMessage: 'answer for #1098 on PR #998\n\nCommitted by the bus from the card\'s worktree after its answer session ended.' }])
    bench.close()
  })

  it('an answer round starts a new session only when the card session is unavailable', async () => {
    const bench = answerBench()
    bench.tools.available = false
    bench.started(1094)
    bench.gitHub.open({ number: 994, review: 'failure' })
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', session: 'new-session-1', resumed: false })
    expect(bench.tools.runs[0]!.argv.slice(-3, -1)).toEqual(['--session-id', 'new-session-1'])
    expect(projectDirOf('/Users/eli/projects/mc-810')).toBe('-Users-eli-projects-mc-810')
    bench.close()
  })

  it('a changes answer carries the findings of review.recorded', async () => {
    const bench = answerBench()
    bench.started(1095)
    bench.gitHub.open({ number: 995, review: 'failure' })
    bench.reviewed(995, ['the lease is not renewed while the session runs', 'scripts/bus/queue.ts has no test for the owner stop'])
    bench.tick()
    const lease = bench.leaseAnswer()!

    expect(answerSourceOf(bench.db, lease)).toMatchObject({ kind: 'changes', findings: ['the lease is not renewed while the session runs', 'scripts/bus/queue.ts has no test for the owner stop'] })
    await bench.answer(lease)
    const prompt = bench.tools.runs[0]!.argv.at(-1)!
    expect(prompt).toContain('- the lease is not renewed while the session runs')
    expect(prompt).toContain('- scripts/bus/queue.ts has no test for the owner stop')
    bench.close()
  })

  it('a widening onto the same module is answered with scope-widened and one onto an owner path becomes question.owner', async () => {
    const bench = answerBench()
    const touches = ['scripts/bus/queue.ts', 'scripts/tests/bus/update-queue.test.ts']
    bench.started(910)
    bench.stopped(910, { reason: 'question.agent', detail: 'the lease query must admit a card with no pull request', widen: ['scripts/bus/lease.ts', 'scripts/tests/bus/lease.test.ts'], touches })
    bench.started(911)
    bench.stopped(911, { reason: 'question.agent', detail: 'the ladder must know the answer queue', widen: ['scripts/construct/implement.workflow'], touches })
    bench.started(912)
    bench.stopped(912, { reason: 'question.agent', detail: 'detect must report the bus', widen: ['src/detect/git.ts'], touches })
    bench.tick()

    const same = await bench.answer(bench.leaseAnswer()!)
    expect(same).toMatchObject({ kind: 'answered', taskKey: bench.question(910), session: CARD_SESSION })
    const [widened] = eventsOf(bench.db, SCOPE_WIDENED)
    expect(widened).toMatchObject({ paths: ['scripts/bus/lease.ts', 'scripts/tests/bus/lease.test.ts'], detail: 'the lease query must admit a card with no pull request' })
    expect(widened!.reason).toContain('scripts/bus')
    expect(bench.tools.runs[0]!.argv.at(-1)).toContain('The touches are widened')

    const owner = bench.question(911)
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', taskKey: owner, reason: 'question.owner', detail: expect.stringContaining('scripts/construct/implement.workflow is an owner path') })
    const outside = bench.question(912)
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', taskKey: outside, reason: 'question.owner', detail: expect.stringContaining('outside the module') })
    expect(bench.tools.runs).toHaveLength(1)
    expect(eventsOf(bench.db, SCOPE_WIDENED)).toHaveLength(1)
    expect(ownerInbox(bench.db).map(line => line.card_id)).toEqual([911, 912])

    bench.tick()
    expect(bench.leaseAnswer()).toBeNull()
    bench.close()
  })

  it('a question stopped at a head the poller has not seen yet is queued again once the pull request reaches it', () => {
    const bench = answerBench()
    bench.gitHub.open({ number: 990 })
    bench.tick()
    bench.stopped(1090, { reason: 'question.agent', detail: 'pushed and stopped before the poll' }, 990, sha('b'))
    bench.tick()
    bench.tick()
    expect(taskState(bench.db, bench.question(1090, 990, sha('a'))).state).toBe('queued')

    bench.gitHub.open({ number: 990, head: sha('b') })
    bench.tick()
    bench.tick()

    expect(taskState(bench.db, bench.question(1090, 990, sha('a'))).state).toBe('superseded')
    expect(taskState(bench.db, bench.question(1090, 990, sha('b'))).state).toBe('queued')
    expect(bench.leaseAnswer()).toMatchObject({ taskKey: bench.question(1090, 990, sha('b')), head: sha('b') })
    bench.close()
  })

  it('a second question on the same card and head is answered', async () => {
    const bench = answerBench()
    bench.tools.heads = [sha('a'), PUSHED, PUSHED, sha('f')]
    bench.started(920)
    bench.stopped(920, { reason: 'question.agent', detail: 'which reader owns the session id?' })
    bench.tick()
    const first = bench.question(920)
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', taskKey: first })

    bench.stopped(920, { reason: 'question.agent', detail: 'and which one owns the lease?' })
    bench.tick()
    const second = bench.question(920)
    expect(second).not.toBe(first)
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', taskKey: second })
    expect(eventsOf(bench.db, CARD_ANSWERED)).toHaveLength(2)

    bench.stopped(920, { reason: 'question.agent', detail: 'and which one owns the lease?' })
    bench.tick()
    expect(bench.leaseAnswer()).toBeNull()
    bench.close()
  })

  it('a second question on the same card and head is answered when the card has a pull request', async () => {
    const bench = answerBench()
    bench.tools.heads = [sha('a'), sha('a'), sha('a'), PUSHED]
    bench.started(1080)
    bench.gitHub.open({ number: 980 })
    bench.tick()
    bench.stopped(1080, { reason: 'question.agent', detail: 'the first question' }, 980, sha('a'))
    bench.tick()
    const first = bench.question(1080, 980, sha('a'))
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', taskKey: first, reason: 'fault' })

    bench.started(1080, 'card-session-2')
    bench.stopped(1080, { reason: 'question.agent', detail: 'the second question' }, 980, sha('a'))
    bench.tick()
    const second = bench.question(1080, 980, sha('a'))
    expect(second).not.toBe(first)
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', taskKey: second, session: 'card-session-2', head: PUSHED })

    bench.tick()
    expect(bench.leaseAnswer()).toBeNull()
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('a card with changes on its head and a question.agent stop gets one answer task, not two', () => {
    const bench = answerBench()
    bench.gitHub.open({ number: 990, review: 'failure' })
    bench.started(1090)
    bench.stopped(1090, { reason: 'question.agent', detail: 'which reader owns the session id?' }, 990, sha('a'))
    bench.tick()

    const queued = (bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer' AND state = 'queued'`).all() as { task_key: string }[]).map(row => row.task_key)
    expect(queued).toEqual([bench.question(1090, 990, sha('a'))])
    bench.close()
  })

  it('a red CI on the head of a card PR queues one answer task with the failed checks', async () => {
    const bench = answerBench()
    bench.started(1101)
    bench.gitHub.open({ number: 1001, required: 'failure', failed: ['lint', 'vitest (1/2)'] })
    bench.tick()
    bench.tick()

    const queued = (bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer'`).all() as { task_key: string }[]).map(row => row.task_key)
    expect(queued).toEqual([answer(1101, 1001, sha('a'))])
    const lease = bench.leaseAnswer()!
    expect(answerSourceOf(bench.db, lease)).toMatchObject({ kind: 'ci', failedChecks: ['lint', 'vitest (1/2)'] })

    expect(await bench.answer(lease)).toMatchObject({ kind: 'answered', taskKey: answer(1101, 1001, sha('a')), head: PUSHED })
    expect(bench.tools.runs[0]!.argv.at(-1)).toContain('The failed checks: lint, vitest (1/2).')
    expect(eventsOf(bench.db, CARD_ANSWERED)).toEqual([{ session: CARD_SESSION, resumed: true, source: 'ci', from: sha('a'), to: PUSHED }])
    bench.tick()
    expect(bench.leaseAnswer()).toBeNull()
    bench.close()
  })

  it('a changes verdict outranks a red CI on the same head', () => {
    const bench = answerBench()
    bench.started(1104)
    bench.gitHub.open({ number: 1004, review: 'failure', required: 'failure', failed: ['lint'] })
    bench.reviewed(1004, ['the lease is not renewed while the session runs'])
    bench.tick()
    bench.tick()

    const queued = (bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer'`).all() as { task_key: string }[]).map(row => row.task_key)
    expect(queued).toEqual([answer(1104, 1004, sha('a'))])
    expect(answerSourceOf(bench.db, bench.leaseAnswer()!)).toMatchObject({ kind: 'changes', findings: ['the lease is not renewed while the session runs'] })
    bench.close()
  })

  it('a pending CI queues no answer', () => {
    const bench = answerBench()
    bench.started(1102)
    bench.gitHub.open({ number: 1002, required: 'pending', failed: ['lint'] })
    bench.started(1103)
    bench.gitHub.open({ number: 1003, required: 'success' })
    bench.tick()

    expect(bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer'`).all()).toEqual([])
    expect(bench.leaseAnswer()).toBeNull()
    bench.close()
  })

  it('a stop suffix on a review, merge or update task key fails the identity check', () => {
    const stored = (queue: string, suffix: string): StoredEvent => {
      const key = `${taskKey({ queue: queue as Queue, cardId: 1090, pr: 990, head: sha('a') })}${suffix}`
      return { id: 1, ts: '2026-10-10T00:00:00.000Z', type: TASK_ENQUEUED, card_id: 1090, pr: 990, head: sha('a'), dedupe_key: `${TASK_ENQUEUED}:${key}`, payload: JSON.stringify({ task_key: key, queue }) }
    }
    for (const queue of ['review', 'merge', 'update'])
      expect(() => identityOf(stored(queue, ':stop-9'))).toThrow(Rejection)
    expect(identityOf(stored('answer', ':stop-9')).key).toBe(`${answer(1090, 990, sha('a'))}:stop-9`)
  })

  it('a card with an open pull request and changes on its current head gets an answer task within two ticks in any card state', async () => {
    const bench = answerBench()
    const ownerQuestion = 'the finding asks for a change to architecture/owner-merges.md'
    bench.tools.heads = [sha('a'), sha('a')]
    bench.started(1142)
    bench.gitHub.open({ number: 1042, review: 'failure' })
    bench.tick()
    const lease = bench.leaseAnswer()!
    bench.tools.during = () => writeFileSync(ownerQuestionPath(bench.answers, CARD_SESSION, lease.leaseGen), `${ownerQuestion}\n`)
    expect(await bench.answer(lease)).toMatchObject({ kind: 'stopped', reason: 'question.owner' })

    const states: Record<number, () => void> = {
      1140: () => bench.started(1140),
      1141: () => bench.stopped(1141, { reason: 'question.owner', detail: 'may the card touch architecture/owner-merges.md?' }),
      1143: () => bench.stopped(1143, { reason: 'fault', detail: 'the chain fell' }),
      1144: () => bench.stopped(1144, { reason: 'question.agent', detail: 'which reader owns the session id?' }, 1044, sha('a')),
    }
    for (const [cardId, state] of Object.entries(states)) {
      state()
      bench.gitHub.open({ number: Number(cardId) - 100, review: 'failure' })
    }
    recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: 84, text: '#1141 and #1142 may go on', cards: [1141, 1142] })
    bench.tick()
    bench.tick()

    const tasked = (bench.db.prepare(`SELECT DISTINCT card_id FROM tasks WHERE queue = 'answer' AND state = 'queued' AND head = ? ORDER BY card_id`).all(sha('a')) as { card_id: number }[]).map(row => row.card_id)
    expect(tasked).toEqual([1140, 1141, 1142, 1143, 1144])
    expect(taskState(bench.db, answer(1142, 1042, sha('a')))).toMatchObject({ state: 'queued', failures: 0 })
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('repeated ticks set no second task on the same head', async () => {
    const bench = answerBench()
    bench.tools.heads = [sha('a'), sha('a')]
    bench.started(1150)
    bench.gitHub.open({ number: 1050, review: 'failure' })
    bench.tick()
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', reason: 'fault' })
    bench.started(1151)
    bench.stopped(1151, { reason: 'question.agent', detail: 'which reader owns the session id?' }, 1051, sha('a'))
    bench.gitHub.open({ number: 1051, review: 'failure' })
    for (let tick = 0; tick < 4; tick++)
      bench.tick()

    const live = (bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer' AND state IN ('queued', 'leased') ORDER BY task_key`).all() as { task_key: string }[]).map(row => row.task_key)
    expect(live).toEqual([answer(1150, 1050, sha('a')), bench.question(1151, 1051, sha('a'))])
    expect(bench.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'answer'`).get()).toEqual({ n: 2 })
    expect(eventsOf(bench.db, 'task.requeued')).toHaveLength(1)
    bench.close()
  })

  it('after a fault the task is set again, and the third failure writes board.alarm and no owner inbox item', async () => {
    const bench = answerBench()
    bench.tools.heads = Array.from({ length: 2 * FAILURES_TO_STOP }, () => sha('a'))
    bench.started(1160)
    bench.gitHub.open({ number: 1060, review: 'failure' })
    bench.tick()
    const key = answer(1160, 1060, sha('a'))

    for (let failure = 1; failure <= FAILURES_TO_STOP; failure++) {
      expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', taskKey: key, reason: 'fault' })
      expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
      bench.tick()
      bench.tick()
      if (failure < FAILURES_TO_STOP)
        expect(taskState(bench.db, key)).toMatchObject({ state: 'queued', failures: failure })
    }

    expect(taskState(bench.db, key).state).toBe('completed')
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([{ task_key: key, reason: 'fault', failures: FAILURES_TO_STOP, detail: expect.stringContaining(key) }])
    expect(ownerInbox(bench.db)).toEqual([])
    bench.tick()
    expect(bench.leaseAnswer()).toBeNull()
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('an open owner question raised after a fault holds the faulted answer task', async () => {
    const bench = answerBench()
    bench.tools.heads = [sha('a'), sha('a')]
    bench.started(1180)
    bench.gitHub.open({ number: 1080, review: 'failure' })
    bench.tick()
    const key = answer(1180, 1080, sha('a'))
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', taskKey: key, reason: 'fault' })
    bench.stopped(1180, { reason: 'question.owner', detail: 'may the card touch architecture/owner-merges.md?' }, 1080, sha('a'))
    bench.tick()
    bench.tick()

    expect(taskState(bench.db, key).state).toBe('completed')
    expect(eventsOf(bench.db, TASK_REQUEUED)).toEqual([])
    expect(ownerInbox(bench.db).map(line => line.card_id)).toEqual([1180])
    bench.close()
  })

  it('an owner decision naming a card stopped on question.owner returns its pull request to the answer queue on its current head, and its answer folds without a rejection', async () => {
    const bench = answerBench()
    bench.tools.heads = [sha('a'), sha('a'), sha('a'), PUSHED]
    bench.started(1170)
    bench.gitHub.open({ number: 1070, review: 'failure' })
    bench.tick()
    const key = answer(1170, 1070, sha('a'))
    const lease = bench.leaseAnswer()!
    bench.tools.during = () => writeFileSync(ownerQuestionPath(bench.answers, CARD_SESSION, lease.leaseGen), 'may the card touch architecture/owner-merges.md?\n')
    expect(await bench.answer(lease)).toMatchObject({ kind: 'stopped', taskKey: key, reason: 'question.owner' })
    bench.tick()
    expect(taskState(bench.db, key).state).toBe('completed')
    expect(bench.db.prepare('SELECT state FROM cards WHERE card_id = 1170').get()).toEqual({ state: 'stopped' })

    recordDecision(bench.db, { ts: bench.clock.now().toISOString(), decisionId: 95, text: 'the card may touch architecture/owner-merges.md', cards: [1170] })
    bench.tick()

    expect(taskState(bench.db, key)).toMatchObject({ state: 'queued' })
    expect(bench.db.prepare('SELECT state FROM cards WHERE card_id = 1170').get()).toEqual({ state: 'in_review' })
    const released = bench.leaseAnswer()!
    expect(released).toMatchObject({ taskKey: key, pr: 1070, head: sha('a') })

    bench.tools.during = () => {}
    expect(await bench.answer(released)).toMatchObject({ kind: 'answered', head: PUSHED })
    bench.tick()
    expect(reduce(bench.db)).toMatchObject({ rejected: 0 })
    expect(eventsOf(bench.db, REJECTED)).toEqual([])
    expect(bench.db.prepare('SELECT state FROM cards WHERE card_id = 1170').get()).toEqual({ state: 'in_review' })
    bench.close()
  })

  it('the merge of a card that blocks a card stopped on an owner question answers it', async () => {
    const bench = answerBench()
    bench.tools.heads = [sha('a'), sha('a'), sha('a'), PUSHED]
    bench.started(1170)
    bench.gitHub.open({ number: 1070, review: 'failure' })
    bench.tick()
    const key = answer(1170, 1070, sha('a'))
    const lease = bench.leaseAnswer()!
    bench.tools.during = () => writeFileSync(ownerQuestionPath(bench.answers, CARD_SESSION, lease.leaseGen), 'may the card touch architecture/owner-merges.md?\n')
    expect(await bench.answer(lease)).toMatchObject({ kind: 'stopped', taskKey: key, reason: 'question.owner' })
    bench.tick()
    const blocksTheStoppedCard = '#1171 adopt-mode [implement/netwatch/S/cheap/auto] · depends — · blocks #1170'
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: 1171, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:1171`, payload: { card: blocksTheStoppedCard, lane: null, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
    bench.startLine({ task: '1171', card: { id: 1171, line: blocksTheStoppedCard, blocks: [1170] } })
    bench.gitHub.open({ number: 1071 })
    bench.tick()
    expect(taskState(bench.db, key).state).toBe('completed')
    expect(ownerInbox(bench.db).map(line => line.card_id)).toEqual([1170])

    bench.gitHub.close(1071, true)
    bench.tick()
    bench.tick()

    expect(ownerInbox(bench.db)).toEqual([])
    const released = bench.leaseAnswer()!
    expect(released).toMatchObject({ cardId: 1170, pr: 1070, head: sha('a') })
    bench.tools.during = () => {}
    expect(await bench.answer(released)).toMatchObject({ kind: 'answered', head: PUSHED })
    bench.tick()
    expect(bench.db.prepare(`SELECT card_id FROM events WHERE type = '${CARD_ANSWERED}'`).all()).toEqual([{ card_id: 1170 }])
    expect(eventsOf(bench.db, REJECTED)).toEqual([])
    bench.close()
  })

  it('a card stopped on an owner question stays stopped when a card that does not block it merges', () => {
    const bench = answerBench()
    bench.started(1170)
    bench.stopped(1170, { reason: 'question.owner', detail: 'which way?' }, 1070, sha('a'))
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: 1171, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:1171`, payload: { card: '#1171 other [implement/netwatch/S/cheap/auto] · depends #1170 · blocks #11700', lane: null, decision: 'auto', contour: 'cheap', depends: [1170] }, legacy: false })
    bench.gitHub.open({ number: 1071 })
    bench.tick()
    bench.gitHub.close(1071, true)
    bench.tick()
    expect(ownerInbox(bench.db).map(line => line.card_id)).toEqual([1170])
    bench.close()
  })

  it('a card stopped on an owner question stays in the owner inbox until every card that blocks it has merged, then enters the answer queue', () => {
    const bench = answerBench()
    bench.started(1170)
    bench.stopped(1170, { reason: 'question.owner', detail: 'may the card touch architecture/owner-merges.md?' }, 1070, sha('a'))
    bench.gitHub.open({ number: 1070, review: 'failure' })
    for (const [blocker, blocks] of [[1171, '#1170'], [1172, '#1170 (1170a)']] as const) {
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: blocker, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${blocker}`, payload: { card: `#${blocker} part-${blocker} [implement/netwatch/S/cheap/auto] · depends — · blocks ${blocks}`, lane: null, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
      bench.gitHub.open({ number: blocker - 100 })
    }
    bench.tick()
    const answerTasks = (): unknown[] => bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer' AND card_id = 1170 AND state = 'queued'`).all()
    expect(answerTasks()).toEqual([])

    bench.gitHub.close(1071, true)
    bench.tick()
    bench.tick()
    expect(ownerInbox(bench.db).map(line => line.card_id)).toEqual([1170])
    expect(answerTasks()).toEqual([])

    bench.gitHub.close(1072, true)
    bench.tick()
    bench.tick()
    expect(ownerInbox(bench.db)).toEqual([])
    expect(answerTasks()).toEqual([{ task_key: answer(1170, 1070, sha('a')) }])
    bench.close()
  })

  it('a card stopped on an owner question stays stopped when every card that blocks it merged before the stop', () => {
    const bench = answerBench()
    bench.started(1170)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: 1171, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:1171`, payload: { card: '#1171 earlier [implement/netwatch/S/cheap/auto] · depends — · blocks #1170', lane: null, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
    bench.gitHub.open({ number: 1071 })
    bench.tick()
    bench.gitHub.close(1071, true)
    bench.tick()
    bench.tick()
    bench.stopped(1170, { reason: 'question.owner', detail: 'which way?' }, 1070, sha('a'))
    bench.tick()
    expect(ownerInbox(bench.db).map(line => line.card_id)).toEqual([1170])
    bench.close()
  })

  it('a card re-admitted with a line that no longer blocks the stopped card does not hold its owner question', () => {
    const bench = answerBench()
    bench.started(1170)
    bench.stopped(1170, { reason: 'question.owner', detail: 'which way?' }, 1070, sha('a'))
    const admit = (cardId: number, card: string, key: string): void => {
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${key}`, payload: { card, lane: null, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
    }
    admit(1171, '#1171 moved-away [implement/netwatch/S/cheap/auto] · depends — · blocks #1170', '1171')
    admit(1171, '#1171 moved-away [implement/netwatch/S/cheap/auto] · depends — · blocks —', '1171:readmitted')
    admit(1172, '#1172 the-answer [implement/netwatch/S/cheap/auto] · depends — · blocks #1170', '1172')
    bench.gitHub.open({ number: 1072 })
    bench.tick()
    bench.gitHub.close(1072, true)
    bench.tick()
    bench.tick()
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('an answer that leaves no new head while changes stand on the current head stops the card with the reason in the detail and shows it on the board', async () => {
    const bench = answerBench()
    bench.tools.heads = [sha('a'), sha('a')]
    bench.started(1171)
    bench.gitHub.open({ number: 1071, review: 'failure' })
    bench.tick()
    const key = answer(1171, 1071, sha('a'))
    const detail = `the answer session ${CARD_SESSION} left ${key} at ${sha('a')}`

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', reason: 'fault', detail })
    expect(eventsOf(bench.db, CARD_STOPPED)).toEqual([{ reason: 'fault', detail }])
    bench.tick()

    const row = readBoard({ db: bench.db, now: bench.clock.now(), watched: [], parking: [], leaseOrders: {} }).execution.find(each => each.card === 1171)
    expect(row).toMatchObject({ pr: 1071, stage: 'fixes', markers: [`stopped fault: ${detail}`] })
    bench.close()
  })

  it('a task.requeued is refused for a completed task of any queue but answer', () => {
    const bench = answerBench()
    bench.started(1170)
    bench.gitHub.open({ number: 1070, review: 'failure' })
    bench.gitHub.open({ number: 1071 })
    bench.tick()
    const ts = bench.clock.now().toISOString()
    queueTask(bench.db, ts, { queue: 'review', cardId: 1171, pr: 1071, head: sha('a') })
    const completed = (queue: Queue): Lease => {
      const lease = leaseNext(bench.db, ts, queue, `worker:${queue}:worker-1`)!
      completeTask(bench.db, ts, lease, [])
      return lease
    }
    const requeue = (lease: Lease): void => {
      const { id } = bench.db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }
      TASK_FOLDS[TASK_REQUEUED]!(bench.db, { id, ts, type: TASK_REQUEUED, card_id: lease.cardId, pr: lease.pr, head: lease.head, dedupe_key: `${TASK_REQUEUED}:${lease.taskKey}`, payload: JSON.stringify({ task_key: lease.taskKey, queue: lease.queue, failure: id }) })
    }
    const review = completed('review')
    const answered = completed('answer')

    expect(() => requeue(review)).toThrow(new Rejection(`task ${review.taskKey} is completed, not stopped or withdrawn or superseded`))
    expect(taskState(bench.db, review.taskKey).state).toBe('completed')
    requeue(answered)
    expect(taskState(bench.db, answered.taskKey)).toMatchObject({ state: 'queued', failures: 0 })
    bench.close()
  })

  it('an answer with a stale lease_gen is refused and writes nothing', async () => {
    const bench = answerBench()
    bench.started(1096)
    bench.gitHub.open({ number: 996, review: 'failure' })
    bench.tick()
    const old = bench.leaseAnswer('worker:answer:old')!
    bench.clock.advance(LEASE_MS + 1)
    expect(expireLeases(bench.db, bench.clock.now().toISOString())).toEqual([answer(1096, 996, sha('a'))])
    const current = bench.leaseAnswer('worker:answer:new')!
    expect([old.leaseGen, current.leaseGen]).toEqual([1, 2])

    const before = eventCount(bench.db)
    expect(await bench.answer(old)).toEqual({ kind: 'fenced', taskKey: answer(1096, 996, sha('a')) })
    expect(eventCount(bench.db)).toBe(before)
    expect(bench.tools.runs).toEqual([])

    bench.tools.during = () => {
      bench.clock.advance(LEASE_MS + 1)
      expireLeases(bench.db, bench.clock.now().toISOString())
      bench.leaseAnswer('worker:answer:third')
    }
    const during = eventCount(bench.db)
    expect(await bench.answer(current)).toEqual({ kind: 'fenced', taskKey: answer(1096, 996, sha('a')) })
    expect(eventsOf(bench.db, CARD_ANSWERED)).toEqual([])
    expect(eventCount(bench.db) - during).toBe(2)
    bench.close()
  })
})

describe('the answer executor', () => {
  it('no_card_tree only when the card has neither a start line nor an open pull request', async () => {
    const bench = answerBench()
    bench.tools.heads = [sha('a'), PUSHED, sha('a'), PUSHED]
    bench.startLine({ task: '931', worktree: bench.treeOf(931), branch: 'feat/card-931' })
    bench.stopped(931, { reason: 'question.agent', detail: 'a card with a start line' })
    bench.gitHub.open({ number: 932, review: 'failure' })
    bench.tick()
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', taskKey: bench.question(931) })
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', taskKey: answer(1032, 932, sha('a')) })

    bench.stopped(930, { reason: 'question.agent', detail: 'a card nobody started' })
    bench.tick()
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'denied', taskKey: bench.question(930), denial: { reason: 'no_card_tree' }, next: 'queued' })
    expect(eventsOf(bench.db, POLICY_DENIED)).toMatchObject([{ command: 'answer', kind: 'technical', reason: 'no_card_tree' }])
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('a card whose tree is gone and has no open pull request is withdrawn with its own denial, spawns nothing and is not counted toward the third failure', async () => {
    const bench = answerBench()
    bench.started(1099)
    rmSync(bench.treeOf(1099), { recursive: true })
    bench.stopped(1099, { reason: 'question.agent', detail: 'a question from a tree that is gone' })
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'denied', denial: { reason: 'card_tree_gone', detail: expect.stringContaining(bench.treeOf(1099)) }, next: 'withdrawn' })
    expect(bench.tools.runs).toEqual([])
    expect(bench.tools.recreated).toEqual([])
    expect(eventsOf(bench.db, POLICY_DENIED)).toMatchObject([{ command: 'answer', kind: 'technical', reason: 'card_tree_gone' }])
    expect(taskState(bench.db, bench.question(1099)).state).toBe('withdrawn')
    expect(eventsOf(bench.db, CARD_STOPPED)).toEqual([{ reason: 'question.agent', detail: 'a question from a tree that is gone' }])
    bench.tick()
    expect(bench.leaseAnswer()).toBeNull()
    bench.close()
  })

  it('a failed recreation of the card tree is a technical answer_failed denial and the task is queued again', async () => {
    const bench = answerBench()
    bench.tools.recreating = () => {
      throw new Error('git worktree add failed')
    }
    bench.gitHub.open({ number: 996, review: 'failure' })
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'denied', taskKey: answer(1096, 996, sha('a')), denial: { kind: 'technical', reason: 'answer_failed', detail: expect.stringContaining('git worktree add failed') }, next: 'queued' })
    expect(bench.tools.runs).toEqual([])
    expect(eventsOf(bench.db, POLICY_DENIED)).toMatchObject([{ command: 'answer', kind: 'technical', reason: 'answer_failed' }])
    expect(taskState(bench.db, answer(1096, 996, sha('a'))).state).toBe('queued')
    bench.close()
  })

  it('a session that pushes no new head stops the card with fault', async () => {
    const bench = answerBench()
    bench.tools.heads = [sha('a'), sha('a')]
    bench.started(1098)
    bench.gitHub.open({ number: 998, review: 'failure' })
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', reason: 'fault' })
    expect(eventsOf(bench.db, CARD_ANSWERED)).toEqual([])
    bench.close()
  })

  it('a session that asks for the owner stops the card with question.owner and its reason, and the owner inbox shows it', async () => {
    const bench = answerBench()
    const reason = 'the finding asks for a change to architecture/owner-merges.md'
    bench.tools.heads = [sha('a'), sha('a')]
    bench.started(1097)
    bench.gitHub.open({ number: 997, review: 'failure' })
    bench.tick()
    const lease = bench.leaseAnswer()!
    const ownerQuestion = ownerQuestionPath(bench.answers, CARD_SESSION, lease.leaseGen)
    bench.tools.during = () => writeFileSync(ownerQuestion, `${reason}\n`)

    expect(await bench.answer(lease)).toMatchObject({ kind: 'stopped', reason: 'question.owner', detail: reason })
    expect(bench.tools.runs[0]!.argv.at(-1)).toContain(ownerQuestion)
    expect(eventsOf(bench.db, CARD_STOPPED)).toEqual([{ reason: 'question.owner', detail: reason }])
    expect(eventsOf(bench.db, CARD_ANSWERED)).toEqual([])
    expect(bench.tools.published).toEqual([])
    const inbox = ownerInbox(bench.db)
    expect(inbox.map(line => line.card_id)).toEqual([1097])
    expect(inboxText(inbox[0]!)).toContain(reason)
    bench.close()
  })

  it('a session question about touches stops the card as question.agent, and only R1, an owner path or a reserved item outside an active delegation goes to question.owner', async () => {
    const bench = answerBench()
    const ownerPath = 'the finding asks for a change to contract/factory-permissions.json'
    const reserved = (cardId: number): string => `card #${cardId} reserved by the owner: may the answer go on?`
    const questions: Record<number, string> = {
      1120: 'may the card also touch scripts/bus/lease.ts, scripts/tests/bus/lease.test.ts and package.json?',
      1121: 'the finding needs src/materialize/plan.ts.',
      1122: ownerPath,
      1123: reserved(1123),
      1124: reserved(1124),
      1125: ownerPath,
      1126: 'may the card also touch AGENTS.md?',
      1127: 'the finding needs eslint.config.mjs',
      1128: 'may the card also touch scripts/bus/lease.ts?',
    }
    const delegated = [1124, 1125, 1127, 1128]
    const cards = Object.keys(questions).map(Number)
    bench.tools.heads = cards.flatMap(() => [sha('a'), sha('a')])
    for (const cardId of cards) {
      bench.started(cardId)
      bench.gitHub.open({ number: cardId - 100, review: 'failure' })
    }
    for (const cardId of delegated)
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:${cardId}`, payload: { id: `shard-${cardId}`, under: null }, legacy: false })
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: DECISION_RECORDED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${DECISION_RECORDED}:90`, payload: { source: 'owner', decision_id: 90, text: '#1128 reserved: the owner answers it', scope: [1128] }, legacy: false })
    bench.tick()

    const reasons: Record<number, string> = {}
    for (const _ of cards) {
      const lease = bench.leaseAnswer()!
      bench.tools.during = () => writeFileSync(ownerQuestionPath(bench.answers, CARD_SESSION, lease.leaseGen), `${questions[lease.cardId]}\n`)
      const outcome = await bench.answer(lease)
      expect(outcome).toMatchObject({ kind: 'stopped', detail: questions[lease.cardId] })
      reasons[lease.cardId] = (outcome as { reason: string }).reason
    }

    expect(reasons).toEqual({
      1120: 'question.agent',
      1121: 'question.owner',
      1122: 'question.owner',
      1123: 'question.owner',
      1124: 'question.owner',
      1125: 'question.agent',
      1126: 'question.owner',
      1127: 'question.agent',
      1128: 'question.owner',
    })
    expect(ownerInbox(bench.db).map(line => line.card_id)).toEqual([1121, 1122, 1123, 1124, 1126, 1128])
    expect(bench.tools.published).toEqual([])
    bench.tick()
    const asked = (bench.db.prepare(`SELECT card_id FROM tasks WHERE queue = 'answer' AND state = 'queued' ORDER BY card_id`).all() as { card_id: number }[]).map(row => row.card_id)
    expect(asked).toEqual([1120, 1125, 1127])
    bench.close()
  })

  it('a pull request that turns dirty after its last round gets an answer task to resolve the conflict on its current head', async () => {
    const bench = answerBench()
    bench.started(1130)
    bench.gitHub.open({ number: 1030, review: 'failure' })
    bench.tick()
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', taskKey: answer(1130, 1030, sha('a')), head: PUSHED })

    bench.gitHub.open({ number: 1030, head: PUSHED, review: 'success', mergeable_state: 'dirty' })
    bench.started(1131)
    bench.gitHub.open({ number: 1031, head: sha('b'), mergeable_state: 'dirty', draft: true })
    bench.tick()
    bench.tick()

    const queued = (bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer' AND state = 'queued'`).all() as { task_key: string }[]).map(row => row.task_key)
    expect(queued).toEqual([answer(1130, 1030, PUSHED)])
    bench.tools.heads = [PUSHED, sha('f')]
    const lease = bench.leaseAnswer()!
    expect(answerSourceOf(bench.db, lease)).toBeNull()
    expect(await bench.answer(lease)).toMatchObject({ kind: 'answered', taskKey: answer(1130, 1030, PUSHED), head: sha('f') })
    expect(bench.tools.runs[1]!.argv.at(-1)).toContain(`pull request #1030 conflicts with main at ${PUSHED}`)
    expect(eventsOf(bench.db, POLICY_DENIED)).toEqual([])
    bench.close()
  })
})

describe('the card tree of every start path', () => {
  it('changes on a card started by launch still start a fix round from card.started', async () => {
    const bench = answerBench()
    bench.started(1110)
    bench.startLine({ task: '1110', session: 'an-older-session', worktree: path.join(bench.home, 'mc-1110'), branch: 'feat/card-1110' })
    bench.gitHub.open({ number: 1010, review: 'failure' })
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', session: CARD_SESSION, resumed: true, head: PUSHED })
    expect(bench.tools.runs[0]!.cwd).toBe(bench.treeOf(1110))
    expect(bench.tools.recreated).toEqual([])
    bench.close()
  })

  it('changes on a card started by a shift chain start a fix round without the Operator', async () => {
    const bench = answerBench()
    const tree = path.join(bench.home, 'mc-1111')
    bench.startLine({ task: '1111', shift: '/shift/2026-10-11-f', worktree: tree, branch: 'feat/card-1111' })
    bench.gitHub.open({ number: 1011, review: 'failure' })
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', taskKey: answer(1111, 1011, sha('a')), session: 'new-session-1', resumed: false, head: PUSHED })
    expect(bench.tools.runs[0]!.cwd).toBe(tree)
    expect(bench.tools.runs[0]!.argv.slice(-3, -1)).toEqual(['--session-id', 'new-session-1'])
    expect(bench.tools.published).toEqual([{ branch: 'feat/card-1111', commitMessage: expect.stringContaining('answer for #1111 on PR #1011') }])
    expect(bench.tools.recreated).toEqual([])
    expect(eventsOf(bench.db, POLICY_DENIED)).toEqual([])
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('changes on a card started by task:start start a fix round in its worktree', async () => {
    const bench = answerBench()
    const tree = path.join(bench.home, 'mc-1112')
    bench.startLine({ task: '1112', card: { id: '1112' }, session: 'window-session-1', worktree: tree, branch: 'feat/card-1112' })
    bench.startLine({ task: '1112', verification: 'run', ended: '2026-10-11T10:00:00.000Z' })
    bench.gitHub.open({ number: 1012, review: 'failure' })
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', session: 'new-session-1', resumed: false, head: PUSHED })
    expect(bench.tools.runs[0]!.cwd).toBe(tree)
    expect(bench.tools.runs[0]!.argv).not.toContain('--resume')
    expect(bench.tools.runs[0]!.argv.slice(-3, -1)).toEqual(['--session-id', 'new-session-1'])
    expect(bench.tools.published.map(each => each.branch)).toEqual(['feat/card-1112'])
    expect(eventsOf(bench.db, POLICY_DENIED)).toEqual([])
    bench.close()
  })

  it('changes on a card the Operator ran without launch or a chain start a fix round with no no_card_tree', async () => {
    const bench = answerBench()
    bench.gitHub.open({ number: 1013, review: 'failure' })
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', session: 'new-session-1', resumed: false, head: PUSHED })
    const tree = path.join(bench.home, 'mc-1113')
    expect(bench.tools.recreated).toEqual([{ worktree: tree, branch: 'feat/card-1113' }])
    expect(bench.tools.runs[0]!.cwd).toBe(tree)
    expect(bench.tools.published.map(each => each.branch)).toEqual(['feat/card-1113'])
    expect(eventsOf(bench.db, POLICY_DENIED)).toEqual([])
    bench.close()
  })

  it('an answer task stopped on no_card_tree is queued again once the card tree can be brought up', async () => {
    const bench = answerBench()
    bench.gitHub.open({ number: 1014, review: 'failure' })
    bench.gitHub.open({ number: 1015, review: 'failure' })
    bench.tick()
    const stopOn = (reason: string): void => {
      for (let failure = 0; failure < FAILURES_TO_STOP; failure++)
        failTask(bench.db, bench.clock.now().toISOString(), bench.leaseAnswer()!, { reason, withdraw: false })
    }
    stopOn('no_card_tree')
    stopOn('answer_failed')
    expect(taskState(bench.db, answer(1114, 1014, sha('a'))).state).toBe('stopped')
    expect(taskState(bench.db, answer(1115, 1015, sha('a'))).state).toBe('stopped')

    bench.tick()

    expect(taskState(bench.db, answer(1114, 1014, sha('a')))).toMatchObject({ state: 'queued', failures: 0 })
    expect(taskState(bench.db, answer(1115, 1015, sha('a'))).state).toBe('stopped')
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', taskKey: answer(1114, 1014, sha('a')), head: PUSHED })
    const tree = path.join(bench.home, 'mc-1114')
    expect(bench.tools.recreated).toEqual([{ worktree: tree, branch: 'feat/card-1114' }])
    expect(bench.tools.runs.map(run => run.cwd)).toEqual([tree])
    bench.tick()
    expect(bench.leaseAnswer()).toBeNull()
    bench.close()
  })
})

describe('the widening rule', () => {
  it('reads a test under tests/ as the module of its src/ directory and a by-risk path as an owner path', () => {
    expect(wideningOf(['src/detect/git.ts', 'tests/detect/git.test.ts'], ['src/detect/layout.ts'], OWNER_MERGES).kind).toBe('module')
    expect(wideningOf(['scripts/ghosts/hash.ts'], ['scripts/ghosts/launch.ts'], OWNER_MERGES)).toMatchObject({ kind: 'owner', reason: 'scripts/ghosts/hash.ts is an owner path' })
    expect(wideningOf(['README.md'], ['scripts/bus/queue.ts'], OWNER_MERGES).kind).toBe('owner')
  })

  it('reads a directory or glob touch as its own directory, not its parent', () => {
    for (const touch of ['scripts/bus', 'scripts/bus/', 'scripts/bus/**', 'scripts/bus/*.ts', 'scripts/tests/bus/']) {
      expect(moduleOf(touch)).toBe('scripts/bus')
      expect(wideningOf(['scripts/bus/lease.ts'], [touch], OWNER_MERGES).kind).toBe('module')
      expect(wideningOf(['scripts/board/x.ts'], [touch], OWNER_MERGES)).toMatchObject({ kind: 'owner', reason: expect.stringContaining('outside the module') })
      expect(wideningOf(['scripts/x.ts'], [touch], OWNER_MERGES)).toMatchObject({ kind: 'owner', reason: expect.stringContaining('outside the module') })
    }
  })
})

describe('the answer worker', () => {
  it('ships switched off: without --on it opens nothing and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await runAnswerWorker([], { busPath: '/nonexistent/bus.db', answerer: async () => ({ session: 's', resumed: true, before: null, after: null, owner: null }), ownerMerges: () => OWNER_MERGES, cardText: () => null, session: 'worker-1', pause: async () => {}, isolation: () => ({ level: 'none', why: 'switched off' }) })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
  })
})

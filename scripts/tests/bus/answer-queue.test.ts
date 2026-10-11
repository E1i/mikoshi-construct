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
import { appendEvent } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { importJournal } from '../../bus/import.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, inboxText, ownerInbox, POLICY_DENIED } from '../../bus/inbox.js'
import { expireLeases, failTask, FAILURES_TO_STOP, LEASE_MS, leaseNext } from '../../bus/lease.js'
import { identityOf, TASK_ENQUEUED } from '../../bus/queue.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { REVIEW_RECORDED } from '../../bus/review-worker.js'
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
  }
  const answerer = claudeAnswerer(answers, {
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
    expect(await runAnswerWorker([], { busPath: '/nonexistent/bus.db', answerer: async () => ({ session: 's', resumed: true, before: null, after: null, owner: null }), ownerMerges: () => OWNER_MERGES, session: 'worker-1', pause: async () => {} })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
  })
})

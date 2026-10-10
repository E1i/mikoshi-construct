import type { AnswerOutcome } from '../../bus/answer-executor.js'
import type { AnswerRun } from '../../bus/answerer.js'
import type { Lease } from '../../bus/lease.js'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnswerExecutor, SCOPE_WIDENED } from '../../bus/answer-executor.js'
import { answerSourceOf } from '../../bus/answer-source.js'
import { runAnswerWorker } from '../../bus/answer-worker.js'
import { claudeAnswerer, projectDirOf } from '../../bus/answerer.js'
import { appendEvent } from '../../bus/db.js'
import { taskKey } from '../../bus/identifiers.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, ownerInbox, POLICY_DENIED } from '../../bus/inbox.js'
import { expireLeases, LEASE_MS, leaseNext } from '../../bus/lease.js'
import { projectionDump, reduce } from '../../bus/reducer.js'
import { REVIEW_RECORDED } from '../../bus/review-worker.js'
import { wideningOf } from '../../bus/widening.js'
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
}

function answerBench() {
  const bench = mergeBench()
  const tools: Tools = { runs: [], available: true, heads: [sha('a'), PUSHED], during: () => {} }
  const answerer = claudeAnswerer('/tmp/answers', {
    available: () => tools.available,
    remoteHead: () => tools.heads.shift() ?? null,
    spawn: async (run) => {
      tools.runs.push(run)
      tools.during()
      return 0
    },
    newSession: () => 'new-session-1',
  })
  const executor = new AnswerExecutor({ db: bench.db, answerer, ownerMerges: () => OWNER_MERGES, clock: bench.clock.now })
  const ts = (): string => bench.clock.now().toISOString()
  return {
    ...bench,
    tools,
    leaseAnswer: (actor = 'worker:answer:worker-1'): Lease | null => leaseNext(bench.db, ts(), 'answer', actor),
    answer: (lease: Lease): Promise<AnswerOutcome> => executor.answer(lease),
    started: (cardId: number, session = CARD_SESSION): void => {
      appendEvent(bench.db, { ts: ts(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${cardId}:${session}`, payload: { session, worktree: `/trees/mc-${cardId}`, branch: `feat/card-${cardId}`, base: sha('1') }, legacy: false })
    },
    stopped: (cardId: number, payload: object, pr: number | null = null, head: string | null = null): void => {
      appendEvent(bench.db, { ts: ts(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId, pr, head, dedupeKey: `${CARD_STOPPED}:${cardId}:${JSON.stringify(payload)}`, payload, legacy: false })
    },
    reviewed: (pr: number, findings: string[]): void => {
      appendEvent(bench.db, { ts: ts(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: pr + 100, pr, head: sha('a'), dedupeKey: `${REVIEW_RECORDED}:${pr}`, payload: { head: sha('a'), verdict: 'changes', reviewer_session: 'reviewer-1', findings }, legacy: false })
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

    expect(taskState(bench.db, answer(900))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    expect(taskState(bench.db, answer(1090, 990, sha('a')))).toEqual({ state: 'queued', lease_gen: 0, failures: 0 })
    const keys = (bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer' ORDER BY task_key`).all() as { task_key: string }[]).map(row => row.task_key)
    expect(keys).toEqual([answer(1090, 990, sha('a')), answer(900)])
    expect(ownerInbox(bench.db).map(line => line.card_id)).toEqual([901, 1092])
    expect(bench.leaseAnswer()).toMatchObject({ taskKey: answer(900), queue: 'answer', pr: null, head: null, leaseGen: 1 })
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
    expect(run!.cwd).toBe('/trees/mc-1093')
    expect(run!.argv.slice(-3, -1)).toEqual(['--resume', CARD_SESSION])
    expect(run!.argv).not.toContain('--session-id')
    expect(eventsOf(bench.db, CARD_ANSWERED)).toEqual([{ session: CARD_SESSION, resumed: true, source: 'changes', from: sha('a'), to: PUSHED }])
    expect(taskState(bench.db, answer(1093, 993, sha('a'))).state).toBe('completed')
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
    expect(same).toMatchObject({ kind: 'answered', taskKey: answer(910), session: CARD_SESSION })
    const [widened] = eventsOf(bench.db, SCOPE_WIDENED)
    expect(widened).toMatchObject({ paths: ['scripts/bus/lease.ts', 'scripts/tests/bus/lease.test.ts'], detail: 'the lease query must admit a card with no pull request' })
    expect(widened!.reason).toContain('scripts/bus')
    expect(bench.tools.runs[0]!.argv.at(-1)).toContain('The touches are widened')

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', taskKey: answer(911), reason: 'question.owner', detail: expect.stringContaining('scripts/construct/implement.workflow is an owner path') })
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', taskKey: answer(912), reason: 'question.owner', detail: expect.stringContaining('outside the module') })
    expect(bench.tools.runs).toHaveLength(1)
    expect(eventsOf(bench.db, SCOPE_WIDENED)).toHaveLength(1)
    expect(ownerInbox(bench.db).map(line => line.card_id)).toEqual([911, 912])

    bench.tick()
    expect(bench.leaseAnswer()).toBeNull()
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
  it('a card with no card.started tree is a technical denial counted toward the third failure', async () => {
    const bench = answerBench()
    bench.gitHub.open({ number: 997, review: 'failure' })
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'denied', denial: { reason: 'no_card_tree' }, next: 'queued' })
    expect(eventsOf(bench.db, POLICY_DENIED)).toMatchObject([{ command: 'answer', kind: 'technical', reason: 'no_card_tree' }])
    expect(ownerInbox(bench.db)).toEqual([])
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
})

describe('the widening rule', () => {
  it('reads a test under tests/ as the module of its src/ directory and a by-risk path as an owner path', () => {
    expect(wideningOf(['src/detect/git.ts', 'tests/detect/git.test.ts'], ['src/detect/layout.ts'], OWNER_MERGES).kind).toBe('module')
    expect(wideningOf(['scripts/ghosts/hash.ts'], ['scripts/ghosts/launch.ts'], OWNER_MERGES)).toMatchObject({ kind: 'owner', reason: 'scripts/ghosts/hash.ts is an owner path' })
    expect(wideningOf(['README.md'], ['scripts/bus/queue.ts'], OWNER_MERGES).kind).toBe('owner')
  })
})

describe('the answer worker', () => {
  it('ships switched off: without --on it opens nothing and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await runAnswerWorker([], { busPath: '/nonexistent/bus.db', answerer: async () => ({ session: 's', resumed: true, before: null, after: null }), ownerMerges: () => OWNER_MERGES, session: 'worker-1', pause: async () => {} })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
  })
})

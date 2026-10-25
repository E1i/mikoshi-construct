import type { Queue } from '../../core/identifiers.js'
import type { Lease } from '../../core/lease.js'
import type { StoredEvent } from '../../core/stored.js'
import type { AnswerOutcome } from '../../nodes/answer/answer-executor.js'
import type { Answerer, AnswerRequest, AnswerRun, TreeMerge } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, OWNER_WAIT_OPENED, POLICY_DENIED, REJECTED, REVIEW_RECORDED, SCOPE_WIDENED, SHARD_ISSUED, TASK_ENQUEUED, TASK_RELEASED, TASK_REQUEUED } from '../../core/events.js'
import { taskKey } from '../../core/identifiers.js'
import { inboxText, ownerInbox } from '../../core/inbox.js'
import { completeTask, expireLeases, failTask, LEASE_MS, leaseNext } from '../../core/lease.js'
import { admitCommandOf, answerCardBodyOf, appendedAndReduced, FAILURES_TO_STOP, identityOf, keyOf, queueTask } from '../../core/queue.js'
import { projectionDump, reduce } from '../../core/reducer.js'
import { Rejection } from '../../core/stored.js'
import { importJournal } from '../../intake/import.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { answerSourceOf, NO_RECORDED_SESSION } from '../../nodes/answer/answer-source.js'
import { AnswerNode, runAnswerWorker, VERDICT_NOT_RECORDED } from '../../nodes/answer/answer-worker.js'
import { claudeAnswerer, ownerQuestionPath, projectDirOf, treeMergeOf } from '../../nodes/answer/answerer.js'
import { recordDecision } from '../../policy/decisions.js'
import { cardDecisionCommand } from '../../policy/shards.js'
import { readBoard } from '../../window/board.js'
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
  merge: TreeMerge
}

function answerBench(storesPrompts = false) {
  const bench = mergeBench()
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-trees-'))
  const treeOf = (cardId: number): string => path.join(trees, `mc-${cardId}`)
  const home = path.join(trees, 'worktrees')
  const answers = path.join(trees, 'answers')
  const tools: Tools = { runs: [], available: true, heads: [sha('a'), PUSHED], during: () => {}, published: [], recreated: [], recreating: () => {}, merge: { kind: 'none' } }
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
  const executor = new AnswerExecutor({ db: bench.db, answerer, ownerMerges: () => OWNER_MERGES, clock: bench.clock.now, trees: cardTrees, treeMerge: () => tools.merge, ...(storesPrompts ? { prompts: path.join(trees, 'prompts') } : {}) })
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
    expect(eventsOf(bench.db, CARD_ANSWERED)).toEqual([{ session: CARD_SESSION, worktree: bench.treeOf(1093), resumed: true, source: 'changes', from: sha('a'), to: PUSHED }])
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

  it('card.answered names the stored prompt the answer session was given', async () => {
    const bench = answerBench(true)
    bench.started(1098)
    bench.gitHub.open({ number: 998, review: 'failure' })
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', head: PUSHED })
    const [answered] = eventsOf(bench.db, CARD_ANSWERED) as { prompt_sha: string, prompt_path: string }[]
    expect(readFileSync(answered!.prompt_path, 'utf8')).toBe(bench.tools.runs[0]!.argv.at(-1))
    expect(answered).not.toHaveProperty('card_body_sha')
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
    bench.reviewed(995, ['the lease is not renewed while the session runs', 'scripts/core/queue.ts has no test for the owner stop'])
    bench.tick()
    const lease = bench.leaseAnswer()!

    expect(answerSourceOf(bench.db, lease)).toMatchObject({ kind: 'changes', findings: ['the lease is not renewed while the session runs', 'scripts/core/queue.ts has no test for the owner stop'] })
    await bench.answer(lease)
    const prompt = bench.tools.runs[0]!.argv.at(-1)!
    expect(prompt).toContain('- the lease is not renewed while the session runs')
    expect(prompt).toContain('- scripts/core/queue.ts has no test for the owner stop')
    bench.close()
  })

  it('an answer leased before its verdict is recorded does not answer an older verdict', async () => {
    const bench = answerBench()
    bench.started(1096)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: 1096, pr: 996, head: sha('b'), dedupeKey: `${REVIEW_RECORDED}:996:older`, payload: { head: sha('b'), verdict: 'changes', reviewer_session: 'reviewer-1', findings: ['the finding of the older verdict'] }, legacy: false })
    bench.gitHub.open({ number: 996, review: 'failure' })
    bench.tick()
    const sources: AnswerRequest['source'][] = []
    const answerer = vi.fn<Answerer>(async (request) => {
      sources.push(request.source)
      return { session: CARD_SESSION, resumed: true, before: sha('a'), after: PUSHED, owner: null }
    })
    const trees: CardTreeTools = { home: bench.home, exists: existsSync, branchOf: pr => `feat/card-${pr + 100}`, recreate: () => {}, bringTo: () => {} }
    const node = new AnswerNode({ db: bench.db, answerer, ownerMerges: () => OWNER_MERGES, clock: bench.clock.now, session: 'node-1', cardText: () => null, mode: 'live', env: {}, trees })
    const once = async (): Promise<void> => {
      const controller = new AbortController()
      await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await once()

    expect(answerer).not.toHaveBeenCalled()
    expect(eventsOf(bench.db, TASK_RELEASED)).toEqual([expect.objectContaining({ task_key: answer(1096, 996, sha('a')), reason: VERDICT_NOT_RECORDED })])
    expect(taskState(bench.db, answer(1096, 996, sha('a')))).toMatchObject({ state: 'queued', failures: 0 })

    bench.reviewed(996, ['the finding of the verdict on this head'])
    bench.tick()
    await once()

    expect(sources).toEqual([expect.objectContaining({ kind: 'changes', findings: ['the finding of the verdict on this head'] })])
    bench.close()
  })

  const admitBody = (bench: ReturnType<typeof answerBench>, cardId: number, bodySha: string): void => {
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}:${bodySha}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}-${bodySha}`, bodySha }, legacy: false })
  }
  const WIDEN = ['scripts/core/lease.ts', 'scripts/tests/bus/lease.test.ts']
  const askToWiden = (bench: ReturnType<typeof answerBench>, cardId: number): void => {
    bench.started(cardId)
    bench.stopped(cardId, { reason: 'question.agent', detail: 'the lease query must admit a card with no pull request', widen: WIDEN, touches: ['scripts/core/queue.ts'] })
  }
  const answerTaskCount = (bench: ReturnType<typeof answerBench>): number => Number((bench.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'answer'`).get() as { n: number }).n)

  it('a stop asking for a file in touches enqueues no answer and opens a window wait', () => {
    const bench = answerBench()
    askToWiden(bench, 910)
    bench.tick()
    bench.tick()

    expect(answerTaskCount(bench)).toBe(0)
    expect(bench.leaseAnswer()).toBeNull()
    expect(admitCommandOf(910, 'lane-a')).toBe('pnpm intake --admit <parking>/lane-a/910.md')
    expect(eventsOf(bench.db, OWNER_WAIT_OPENED)).toEqual([{ id: 'Q1', need: 'command', text: expect.stringContaining('card #910 asks to widen its touches: the lease query must admit a card with no pull request'), command: 'pnpm intake --admit <parking>/lane-a/910.md', card: 910 }])
    reduce(bench.db)
    expect(bench.db.prepare('SELECT id, need, command, card_id, state FROM owner_waits').all().map(row => ({ ...row }))).toEqual([{ id: 'Q1', need: 'command', command: 'pnpm intake --admit <parking>/lane-a/910.md', card_id: 910, state: 'open' }])
    bench.close()
  })

  const admitCard = (bench: ReturnType<typeof answerBench>, cardId: number, touches: string[], bodySha: string): number => {
    const text = `card: #${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: ${touches.join(', ')}\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}:${bodySha}`, payload: { card: `#${cardId}`, lane: 'lane-a', text, textSha: textSha(text), bodySha }, legacy: false })
    return Number((bench.db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
  }

  it('after the amend the answer of a touches stop continues', async () => {
    const bench = answerBench()
    askToWiden(bench, 911)
    bench.tick()
    const admission = admitCard(bench, 911, ['scripts/core/queue.ts', ...WIDEN], 'cccc3333')
    bench.tick()

    const lease = bench.leaseAnswer()!
    expect(lease).toMatchObject({ cardId: 911, taskKey: expect.stringMatching(/:card-body-cccc3333:stop-\d+$/) })
    expect(await bench.answer(lease)).toMatchObject({ kind: 'answered', session: CARD_SESSION })
    expect(bench.tools.runs[0]!.argv.at(-1)).toContain(`The touches are widened: ${WIDEN.join(', ')}, by the window's amend of the card.`)
    expect(eventsOf(bench.db, SCOPE_WIDENED)).toEqual([{ paths: WIDEN, admission, detail: 'the lease query must admit a card with no pull request' }])
    expect(eventsOf(bench.db, OWNER_WAIT_OPENED)).toHaveLength(1)
    bench.close()
  })

  it('an admission that does not add the widened paths holds the answer for the window again', async () => {
    const bench = answerBench()
    askToWiden(bench, 913)
    bench.tick()
    admitCard(bench, 913, ['scripts/core/queue.ts', 'scripts/core/lease.ts'], 'eeee5555')
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', reason: 'question.agent', detail: expect.stringContaining('scripts/tests/bus/lease.test.ts not in the touches or creates the card was admitted with') })
    expect(eventsOf(bench.db, CARD_STOPPED).at(-1)).toMatchObject({ widen: ['scripts/tests/bus/lease.test.ts'] })
    expect(bench.tools.runs).toHaveLength(0)
    expect(eventsOf(bench.db, SCOPE_WIDENED)).toEqual([])
    bench.tick()

    expect(bench.leaseAnswer()).toBeNull()
    expect(eventsOf(bench.db, OWNER_WAIT_OPENED)).toHaveLength(2)
    bench.close()
  })

  it('a widen onto an owner path stops as question.owner even after the amend', async () => {
    const bench = answerBench()
    bench.started(914)
    bench.stopped(914, { reason: 'question.agent', detail: 'the ladder must know the answer queue', widen: ['scripts/construct/implement.workflow'], touches: ['scripts/core/queue.ts'] })
    bench.tick()
    admitCard(bench, 914, ['scripts/core/queue.ts', 'scripts/construct/implement.workflow'], 'ffff6666')
    bench.tick()

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', reason: 'question.owner', detail: expect.stringContaining('scripts/construct/implement.workflow is an owner path') })
    expect(bench.tools.runs).toHaveLength(0)
    expect(ownerInbox(bench.db).map(line => line.card_id)).toEqual([914])
    expect(eventsOf(bench.db, OWNER_WAIT_OPENED).at(-1)).toEqual({ id: 'Q2', need: 'decision', text: 'card #914 asks: scripts/construct/implement.workflow is an owner path: the ladder must know the answer queue', command: cardDecisionCommand(914), card: 914 })
    bench.close()
  })

  it('the same question twice in a row enqueues no second answer', async () => {
    const bench = answerBench()
    const repeated = 'which reader owns the session id?'
    bench.tools.heads = [sha('a'), sha('a')]
    bench.started(921)
    bench.stopped(921, { reason: 'question.agent', detail: repeated })
    bench.tick()
    const lease = bench.leaseAnswer()!
    bench.tools.during = () => writeFileSync(ownerQuestionPath(bench.answers, CARD_SESSION, lease.leaseGen), `${repeated}\n`)
    expect(await bench.answer(lease)).toMatchObject({ kind: 'stopped', reason: 'question.agent', detail: repeated })
    bench.tick()
    bench.tick()

    expect(answerTaskCount(bench)).toBe(1)
    expect(bench.leaseAnswer()).toBeNull()
    expect(eventsOf(bench.db, OWNER_WAIT_OPENED)).toEqual([expect.objectContaining({ need: 'command', text: expect.stringContaining('card #921 asked the same question twice in a row'), command: admitCommandOf(921, 'lane-a'), card: 921 })])

    admitBody(bench, 921, 'dddd4444')
    bench.tick()
    expect(bench.leaseAnswer()).toMatchObject({ cardId: 921, taskKey: expect.stringMatching(/:card-body-dddd4444:stop-\d+$/) })
    bench.close()
  })

  it('a different question after a held touches stop is answered without a second wait', () => {
    const bench = answerBench()
    askToWiden(bench, 922)
    bench.tick()
    bench.stopped(922, { reason: 'question.agent', detail: 'a question of its own' })
    bench.tick()

    expect(taskState(bench.db, bench.question(922)).state).toBe('queued')
    expect(eventsOf(bench.db, OWNER_WAIT_OPENED)).toHaveLength(1)
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

  it('an amend on the same head queues a new answer task', async () => {
    const bench = answerBench()
    bench.tools.heads = [sha('a'), sha('a')]
    const admit = (bodySha: string): void => {
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: 1146, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:1146:${bodySha}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-1146-${bodySha}`, bodySha }, legacy: false })
    }
    const answerTasks = (state: string): string[] => (bench.db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer' AND state = ? ORDER BY task_key`).all(state) as { task_key: string }[]).map(row => row.task_key)
    bench.started(1146)
    admit('aaaa1111')
    bench.gitHub.open({ number: 1046, review: 'failure' })
    bench.tick()
    const asking = bench.leaseAnswer()!
    expect(asking.taskKey).toBe(`${answer(1146, 1046, sha('a'))}:card-body-aaaa1111`)
    completeTask(bench.db, bench.clock.now().toISOString(), asking, [{ ts: bench.clock.now().toISOString(), type: CARD_STOPPED, actor: asking.actor, cardId: 1146, pr: 1046, head: sha('a'), dedupeKey: `${CARD_STOPPED}:${asking.taskKey}:${asking.leaseGen}`, payload: { reason: 'question.agent', detail: 'widen touches to the worker test' }, legacy: false }])
    bench.tick()
    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'stopped', reason: 'fault' })
    bench.tick()
    expect(answerTasks('queued')).toEqual([])

    admit('bbbb2222')
    bench.tick()

    expect(answerTasks('queued')).toEqual([`${answer(1146, 1046, sha('a'))}:card-body-bbbb2222`])
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  const liveAnswerTasks = (bench: ReturnType<typeof answerBench>): { task_key: string, state: string }[] =>
    bench.db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'answer' AND state IN ('queued', 'leased') ORDER BY task_key`).all() as { task_key: string, state: string }[]

  it('an amend while the answer task of the older card body is still queued leaves exactly one live answer task, keyed by the new body', () => {
    const bench = answerBench()
    bench.started(1146)
    admitBody(bench, 1146, 'aaaa1111')
    bench.gitHub.open({ number: 1046, review: 'failure' })
    bench.tick()
    expect(liveAnswerTasks(bench)).toEqual([{ task_key: `${answer(1146, 1046, sha('a'))}:card-body-aaaa1111`, state: 'queued' }])

    admitBody(bench, 1146, 'bbbb2222')
    bench.tick()

    expect(liveAnswerTasks(bench)).toEqual([{ task_key: `${answer(1146, 1046, sha('a'))}:card-body-bbbb2222`, state: 'queued' }])
    expect(taskState(bench.db, `${answer(1146, 1046, sha('a'))}:card-body-aaaa1111`).state).toBe('superseded')
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('an admission that arrives while a plain-key answer task is leased supersedes it and leaves exactly one live answer task', () => {
    const bench = answerBench()
    bench.started(1147)
    bench.gitHub.open({ number: 1047, review: 'failure' })
    bench.tick()
    const leased = bench.leaseAnswer()!
    expect(leased.taskKey).toBe(answer(1147, 1047, sha('a')))

    admitBody(bench, 1147, 'cccc3333')
    bench.tick()

    expect(liveAnswerTasks(bench)).toEqual([{ task_key: `${answer(1147, 1047, sha('a'))}:card-body-cccc3333`, state: 'queued' }])
    expect(taskState(bench.db, answer(1147, 1047, sha('a'))).state).toBe('superseded')
    const live = projectionDump(bench.db)
    reduce(bench.db)
    expect(projectionDump(bench.db)).toBe(live)
    bench.close()
  })

  it('an answer task whose key carries a card body is withdrawn when its pull request closes', () => {
    const bench = answerBench()
    bench.started(1148)
    admitBody(bench, 1148, 'dddd4444')
    bench.gitHub.open({ number: 1048, review: 'failure' })
    bench.tick()
    const key = `${answer(1148, 1048, sha('a'))}:card-body-dddd4444`
    expect(taskState(bench.db, key).state).toBe('queued')

    bench.gitHub.close(1048, false)
    bench.tick()

    expect(taskState(bench.db, key).state).toBe('withdrawn')
    expect(liveAnswerTasks(bench)).toEqual([])
    bench.close()
  })

  it('a question.agent stop on a card with an admitted body keeps one live answer task keyed by its card body', () => {
    const bench = answerBench()
    bench.started(1149)
    admitBody(bench, 1149, 'eeee5555')
    bench.stopped(1149, { reason: 'question.agent', detail: 'which reader owns the lease?' })
    bench.tick()
    const { stop } = bench.db.prepare(`SELECT max(id) AS stop FROM events WHERE type = '${CARD_STOPPED}' AND card_id = 1149`).get() as { stop: number }
    const key = `${answer(1149)}:card-body-eeee5555:stop-${stop}`
    expect(liveAnswerTasks(bench)).toEqual([{ task_key: key, state: 'queued' }])

    bench.tick()

    expect(liveAnswerTasks(bench)).toEqual([{ task_key: key, state: 'queued' }])
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
    expect(eventsOf(bench.db, CARD_ANSWERED)).toEqual([{ session: CARD_SESSION, worktree: bench.treeOf(1101), resumed: true, source: 'ci', from: sha('a'), to: PUSHED }])
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

    const row = readBoard({ db: bench.db, now: bench.clock.now(), watched: [], leaseOrders: {} }).execution.find(each => each.card === 1171)
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
      appendedAndReduced(bench.db, { ts, type: TASK_REQUEUED, actor: 'policy', cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${TASK_REQUEUED}:${lease.taskKey}`, payload: { task_key: lease.taskKey, queue: lease.queue }, legacy: false })
    }
    const review = completed('review')
    const answered = completed('answer')

    requeue(review)
    expect(eventsOf(bench.db, REJECTED).map(event => event.reason)).toEqual([`task ${review.taskKey} is completed, not stopped or withdrawn or superseded`])
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
      1120: 'may the card also touch scripts/core/lease.ts, scripts/tests/bus/lease.test.ts and package.json?',
      1121: 'the finding needs src/materialize/plan.ts.',
      1122: ownerPath,
      1123: reserved(1123),
      1124: reserved(1124),
      1125: ownerPath,
      1126: 'may the card also touch AGENTS.md?',
      1127: 'the finding needs eslint.config.mjs',
      1128: 'may the card also touch scripts/core/lease.ts?',
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

  it('a dirty pull request whose card tree stands mid-merge gets an answer that finishes the merge without reset or abort', async () => {
    const bench = answerBench()
    bench.started(1132)
    bench.gitHub.open({ number: 1032, head: PUSHED, review: 'success', mergeable_state: 'dirty' })
    bench.tick()
    bench.tools.merge = { kind: 'mid-merge', files: ['scripts/core/queue.ts', 'package.json'] }
    bench.tools.heads = [PUSHED, sha('f')]

    expect(await bench.answer(bench.leaseAnswer()!)).toMatchObject({ kind: 'answered', taskKey: answer(1132, 1032, PUSHED), head: sha('f') })
    const prompt = bench.tools.runs[0]!.argv.at(-1)!
    expect(prompt).toContain(`its tree ${bench.treeOf(1132)} stands mid-merge with scripts/core/queue.ts, package.json unmerged: finish that merge where it stands`)
    expect(prompt).toContain('never git merge --abort, git reset or a new merge over it')
    expect(prompt).not.toContain(`merge origin/main into the branch`)
    expect(bench.tools.published).toEqual([{ branch: 'feat/card-1132', commitMessage: expect.stringContaining('on PR #1032') }])
    expect(eventsOf(bench.db, CARD_ANSWERED)).toMatchObject([{ source: 'changes', from: PUSHED, to: sha('f') }])
    bench.close()
  })

  it('a dirty pull request whose card tree cannot be read opens a named owner wait and spawns no session', async () => {
    const bench = answerBench()
    bench.started(1133)
    bench.gitHub.open({ number: 1033, head: PUSHED, mergeable_state: 'dirty' })
    bench.tick()
    bench.tools.merge = { kind: 'unreadable', why: 'not a git repository' }

    const outcome = await bench.answer(bench.leaseAnswer()!)
    expect(outcome).toMatchObject({ kind: 'waiting', taskKey: answer(1133, 1033, PUSHED), detail: expect.stringContaining('not a git repository') })
    expect(bench.tools.runs).toEqual([])
    expect(eventsOf(bench.db, OWNER_WAIT_OPENED)).toMatchObject([{ id: (outcome as { wait: string }).wait, need: 'decision', card: 1133, pr: 1033, text: expect.stringContaining(bench.treeOf(1133)) }])
    expect(taskState(bench.db, answer(1133, 1033, PUSHED)).state).toBe('completed')
    bench.tick()
    expect(bench.leaseAnswer()).toBeNull()
    bench.close()
  })

  it('the tree reader sees a merge stopped on a conflict, a clean tree, and a directory that is no git tree', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-answer-merge-'))
    const worktree = path.join(root, 'tree')
    const git = (...args: string[]): string => execFileSync('git', ['-C', worktree, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const card = { session: CARD_SESSION, worktree, branch: 'feat/card-1134' }
    mkdirSync(worktree)
    git('init', '-q', '-b', 'main')
    writeFileSync(path.join(worktree, 'a.txt'), 'base\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', card.branch)
    writeFileSync(path.join(worktree, 'a.txt'), 'card\n')
    git('commit', '-q', '-am', 'card')
    git('checkout', '-q', 'main')
    writeFileSync(path.join(worktree, 'a.txt'), 'main\n')
    git('commit', '-q', '-am', 'main')
    git('checkout', '-q', card.branch)
    expect(treeMergeOf(card)).toEqual({ kind: 'none' })

    expect(() => git('merge', '-q', 'main')).toThrow()
    expect(treeMergeOf(card)).toEqual({ kind: 'mid-merge', files: ['a.txt'] })
    writeFileSync(path.join(worktree, 'a.txt'), 'both\n')
    git('add', 'a.txt')
    expect(treeMergeOf(card)).toEqual({ kind: 'mid-merge', files: [] })

    expect(treeMergeOf({ ...card, worktree: path.join(root, 'gone') })).toMatchObject({ kind: 'unreadable' })
    rmSync(root, { recursive: true, force: true })
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

describe('the answer worker', () => {
  it('ships switched off: without --on it opens nothing and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await runAnswerWorker([], { busPath: '/nonexistent/bus.db', answerer: async () => ({ session: 's', resumed: true, before: null, after: null, owner: null }), ownerMerges: () => OWNER_MERGES, cardText: () => null, session: 'worker-1', pause: async () => {}, isolation: () => ({ level: 'none', why: 'switched off' }) })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('switched off'))
  })
})

describe('the key of a task that carries a card body', () => {
  const BODY = '0123abcd4567ef89'

  it('keyOf refuses a card body on a queue that is not answer', () => {
    expect(() => keyOf({ queue: 'review', cardId: 1114, pr: 1014, head: sha('a'), cardBody: BODY })).toThrow('only an answer task carries a card body sha')
    expect(keyOf({ queue: 'answer', cardId: 1114, pr: 1014, head: sha('a'), cardBody: BODY })).toBe(`${answer(1114, 1014, sha('a'))}:card-body-${BODY}`)
  })

  it('keyOf refuses a malformed card body on an answer task', () => {
    for (const cardBody of ['', 'xyz', 'ABCDEF0123456789', '0123abc'])
      expect(() => keyOf({ queue: 'answer', cardId: 1114, pr: 1014, head: sha('a'), cardBody })).toThrow('only an answer task carries a card body sha')
  })

  it('answerCardBodyOf carries only a well-formed card body sha from a candidate row', () => {
    expect(answerCardBodyOf({ card_body: BODY })).toBe(BODY)
    for (const card_body of [undefined, null, 1146, '', 'xyz', 'ABCDEF0123456789', '0123abc', `${BODY}${BODY}${BODY}${BODY}${BODY}`])
      expect(answerCardBodyOf({ card_body })).toBeUndefined()
  })
})

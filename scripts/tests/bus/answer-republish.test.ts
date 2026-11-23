import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { AnswerOutcome } from '../../nodes/answer/duties/index.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { closedWaitIds, openOwnerWaits } from '../../core/card-readings.js'
import { appendEvent, openBusWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, PR_OBSERVED, PR_OPENED, QUESTION_OWNER } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { all as pullRequests } from '../../core/pr-readings.js'
import { queueTask } from '../../core/queue.js'
import { answerCandidates } from '../../nodes/answer/answer-candidates.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { answerParts, cardTransitions } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 2113
const OPENED_PR = 9850
const SESSION = 'answer-session-2113'
const STRANDED_TASK = `answer:${CARD}:-:${sha('b')}`

const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Stranded {
  made: MergeBench
  candidates: () => number[]
  liveTasks: () => string[]
  answer: (publish: () => void, dirty?: boolean) => Promise<AnswerOutcome>
}

type Condition = (made: MergeBench) => void

function answeredCardWithNoPullRequest(condition: Condition = () => {}): Stranded {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-republish-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: `a question on card #${CARD}` }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_ANSWERED, actor: 'worker:answer:worker-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ANSWERED}:${CARD}:first`, payload: { session: SESSION, worktree, resumed: true, source: 'question', from: sha('a'), to: sha('b') }, legacy: false })
  condition(made)
  made.tick()
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const answerer: Answerer = async () => {
    throw new Error('a stranded card is published without an answer session')
  }
  const candidates = (): number[] => answerCandidates(made.db, made.clock.now().toISOString(), answerParts()).map(task => task.cardId)
  const liveTasks = (): string[] => liveTasksOf(made.db)
  const answer = async (publish: () => void, dirty = false): Promise<AnswerOutcome> => {
    const lease: Lease = leaseNext(made.db, pullRequests(made.db), made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!
    const executor = new AnswerExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => dirty, liveSession: () => null, publishing: { committed: () => true, publish } })
    return executor.answer(lease)
  }
  return { made, candidates, liveTasks, answer }
}

function liveTasksOf(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT task_key FROM tasks WHERE card_id = ? AND state IN ('queued', 'leased') ORDER BY task_key`).all(CARD) as { task_key: string }[]).map(row => row.task_key)
}

function treePrOpens(made: MergeBench, pr: number): () => void {
  return () => {
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: CARD, pr, head: null, dedupeKey: `${PR_OPENED}:${CARD}:${pr}`, payload: { pr }, legacy: false })
  }
}

function cardRow(made: MergeBench): { state: string, pr: number | null } {
  return made.db.prepare('SELECT state, pr FROM cards WHERE card_id = ?').get(CARD) as { state: string, pr: number | null }
}

const anOpenPullRequest: Condition = (made) => {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OBSERVED, actor: 'worker:netwatch:1', cardId: CARD, pr: OPENED_PR, head: sha('b'), dedupeKey: `${PR_OBSERVED}:${OPENED_PR}`, payload: { base: 'main', head: sha('b'), mergeable: 'clean', ci: 'pending', verdict_on_head: null, auto_merge: false, draft: false, branch: `feat/card-${CARD}` }, legacy: false })
}

const anOpenOwnerWait: Condition = (made) => {
  openBusWait(made.db, closedWaitIds(made.db), made.clock.now().toISOString(), 'worker:answer:worker-1', { need: 'decision', text: `card #${CARD} asks: which way`, card: CARD })
}

const aLiveTask: Condition = (made) => {
  queueTask(made.db, made.clock.now().toISOString(), { queue: 'witness', cardId: CARD, head: sha('c') })
}

describe('an answered card the answer round left with no pull request', () => {
  it('an answered card with a pushed head and no PR is published once by the answer node', async () => {
    const bench = answeredCardWithNoPullRequest()
    const publish = vi.fn(treePrOpens(bench.made, OPENED_PR))

    expect(bench.liveTasks()).toEqual([STRANDED_TASK])
    const outcome = await bench.answer(publish)
    bench.made.tick()
    bench.made.tick()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ kind: 'published', session: SESSION, pr: OPENED_PR })
    expect(eventsOf(bench.made.db, CARD_ANSWERED)).toContainEqual(expect.objectContaining({ published: true, pr: OPENED_PR, to: sha('b') }))
    expect(cardRow(bench.made)).toEqual({ state: 'in_review', pr: OPENED_PR })
    expect(bench.liveTasks().filter(key => key.startsWith(`answer:${CARD}:-:`))).toEqual([])
    expect(bench.candidates()).toEqual([])
  })

  it.each([
    ['an open pull request', anOpenPullRequest],
    ['an open owner wait', anOpenOwnerWait],
    ['a live task of the card', aLiveTask],
  ])('an answered card with an open PR, a dirty tree or an open owner wait is not published: %s', (_, condition) => {
    const bench = answeredCardWithNoPullRequest(condition)

    expect(bench.liveTasks()).not.toContain(STRANDED_TASK)
    expect(bench.candidates()).not.toContain(CARD)
  })

  it('an answered card with an open PR, a dirty tree or an open owner wait is not published: a dirty tree', async () => {
    const bench = answeredCardWithNoPullRequest()
    const publish = vi.fn()
    queueTask(bench.made.db, bench.made.clock.now().toISOString(), { queue: 'answer', cardId: CARD, head: sha('b') })

    const outcome = await bench.answer(publish, true)
    bench.made.tick()

    expect(publish).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'nothing_to_answer' } })
    expect(bench.liveTasks()).toEqual([])
  })

  it('a publish that opens no pull request stops the card for the owner', async () => {
    const bench = answeredCardWithNoPullRequest()
    const publish = vi.fn()

    const outcome = await bench.answer(publish)
    bench.made.tick()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: expect.stringContaining(`card #${CARD} was answered at ${sha('b')} with no pull request`) })
    expect(openOwnerWaits(bench.made.db).filter(wait => wait.card === CARD)).toHaveLength(1)
  })

  it('a stranded card leased on a head other than the answered one is not published', async () => {
    const bench = answeredCardWithNoPullRequest(anAnswerTaskOn(sha('c')))
    const publish = vi.fn()

    expect(bench.liveTasks()).toEqual([`answer:${CARD}:-:${sha('c')}`])
    const outcome = await bench.answer(publish)

    expect(publish).not.toHaveBeenCalled()
    expect(outcome.kind).not.toBe('published')
    expect(outcome.kind).not.toBe('stopped')
  })

  it('an answer whose to is not a full sha leaves no stranded card', () => {
    const bench = answeredCardWithNoPullRequest(answeredAgainTo('main'))

    expect(bench.liveTasks()).toEqual([])
    expect(bench.candidates()).not.toContain(CARD)
  })

  it('a pull request opened after the lease keeps the answer node from republishing the card', async () => {
    const bench = answeredCardWithNoPullRequest()
    const publish = vi.fn()
    treePrOpens(bench.made, OPENED_PR)()

    const outcome = await bench.answer(publish)

    expect(publish).not.toHaveBeenCalled()
    expect(outcome.kind).not.toBe('published')
    expect(outcome.kind).not.toBe('stopped')
    expect(openOwnerWaits(bench.made.db).filter(wait => wait.card === CARD)).toEqual([])
  })
})

function anAnswerTaskOn(head: string): Condition {
  return (made) => {
    queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: CARD, head })
  }
}

function answeredAgainTo(to: string): Condition {
  return (made) => {
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ANSWERED, actor: 'worker:answer:worker-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ANSWERED}:${CARD}:second`, payload: { session: SESSION, worktree: 'unused', resumed: true, source: 'question', from: sha('b'), to }, legacy: false })
  }
}

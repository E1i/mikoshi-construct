import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, OWNER_WAIT_OPENED, QUESTION_OWNER } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { FAILURES_TO_STOP, queueTask, REVIEW_ROUNDS } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1439
const SESSION = 'answer-session-1'

const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Card {
  made: MergeBench
  executor: AnswerExecutor
  decide: () => void
  lease: () => Lease | null
}

type AnswerEnd = 'empty' | 'dirty'

function cardWhoseAnswerLeavesNothing(ends: AnswerEnd[] = []): Card {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answerfault-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/construct/M/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: `a question on card #${CARD}` }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, ts, { queue: 'answer', cardId: CARD, stop })
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const answerer: Answerer = async () => ({ session: SESSION, resumed: true, before: sha('a'), after: sha('a'), owner: null })
  const dirty = (): boolean => ends.shift() === 'dirty'
  const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty, liveSession: () => null })
  let decided = 0
  const decide = (): void => {
    decided += 1
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: DECISION_RECORDED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${DECISION_RECORDED}:${decided}`, payload: { source: 'owner', decision_id: 900 + decided, text: `#${CARD}: answer it again`, scope: [CARD] }, legacy: false })
    made.tick()
  }
  return { made, executor, decide, lease: () => leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') }
}

function answerTask(made: MergeBench): { state: string, failures: number } {
  return made.db.prepare(`SELECT state, failures FROM tasks WHERE queue = 'answer' AND card_id = ?`).get(CARD) as { state: string, failures: number }
}

describe('an answer that ends with no new commit, no owner question and a clean tree', () => {
  it('an answer that left no new commit is retried within the round limit', async () => {
    const card = cardWhoseAnswerLeavesNothing()

    const outcome = await card.executor.answer(card.lease()!)

    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'left_nothing', detail: expect.stringContaining(SESSION) as unknown }, next: 'queued' })
    expect(eventsOf(card.made.db, CARD_STOPPED).map(each => each.reason)).toEqual(['question.agent'])
    expect(answerTask(card.made)).toEqual({ state: 'queued', failures: 1 })
    expect(card.lease()).not.toBeNull()
  })

  it('past the round limit, with the owner deciding between empty rounds, a faulted answer opens an owner wait with its cause', async () => {
    const card = cardWhoseAnswerLeavesNothing()

    const outcomes = []
    for (let attempt = 1; attempt <= REVIEW_ROUNDS; attempt++) {
      outcomes.push(await card.executor.answer(card.lease()!))
      card.decide()
    }

    expect(outcomes.map(outcome => outcome.kind)).toEqual([...Array.from({ length: REVIEW_ROUNDS - 1 }).fill('denied'), 'stopped'])
    expect(outcomes.at(-1)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: expect.stringContaining('review round limit') as unknown })
    expect(eventsOf(card.made.db, CARD_STOPPED).map(each => each.reason)).toEqual(['question.agent', QUESTION_OWNER])
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toEqual([expect.objectContaining({ card: CARD, text: expect.stringContaining(`${SESSION} left`) as unknown })])
    expect(answerTask(card.made).state).toBe('completed')
    expect(card.lease()).toBeNull()
  })

  it('an empty answer after a failure of another kind counts only the empty answers in a row', async () => {
    const card = cardWhoseAnswerLeavesNothing(['dirty', 'empty'])

    expect(await card.executor.answer(card.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed' } })
    expect(await card.executor.answer(card.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'left_nothing', detail: expect.stringContaining(`empty answer 1 of the review round limit ${REVIEW_ROUNDS}`) as unknown }, next: 'queued' })
  })

  it('the count of empty answers starts again after a failure of another kind', async () => {
    const card = cardWhoseAnswerLeavesNothing(['empty', 'dirty', 'empty'])

    expect(await card.executor.answer(card.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'left_nothing', detail: expect.stringContaining(`empty answer 1 of the review round limit ${REVIEW_ROUNDS}`) as unknown } })
    card.decide()
    expect(await card.executor.answer(card.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed' } })
    const last = await card.executor.answer(card.lease()!)

    expect(last).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: expect.stringContaining(`1 empty answers in a row and ${FAILURES_TO_STOP} failures in a row of any kind`) as unknown })
  })

  it('an empty answer that would be the task\'s last failure opens the owner wait naming both counts, not a bare fault', async () => {
    const card = cardWhoseAnswerLeavesNothing([...Array.from({ length: FAILURES_TO_STOP - 1 }).fill('dirty') as AnswerEnd[], 'empty'])

    for (let failure = 1; failure < FAILURES_TO_STOP; failure++)
      expect(await card.executor.answer(card.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed' } })
    const last = await card.executor.answer(card.lease()!)

    expect(last).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: expect.stringContaining(`1 empty answers in a row and ${FAILURES_TO_STOP} failures in a row of any kind`) as unknown })
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toHaveLength(1)
    expect(eventsOf(card.made.db, BOARD_ALARM)).toEqual([])
  })

  it('failures of another kind still stop the task with a fault and a board.alarm at the failure limit', async () => {
    const card = cardWhoseAnswerLeavesNothing(Array.from({ length: FAILURES_TO_STOP }).fill('dirty') as AnswerEnd[])

    const outcomes = []
    for (let failure = 1; failure <= FAILURES_TO_STOP; failure++)
      outcomes.push(await card.executor.answer(card.lease()!))

    expect(outcomes.map(outcome => outcome.kind === 'denied' ? outcome.next : outcome.kind)).toEqual([...Array.from({ length: FAILURES_TO_STOP - 1 }).fill('queued'), 'stopped'])
    expect(eventsOf(card.made.db, CARD_STOPPED).map(each => each.reason)).toEqual(['question.agent', 'fault'])
    expect(eventsOf(card.made.db, BOARD_ALARM)).toEqual([expect.objectContaining({ reason: 'fault', failures: FAILURES_TO_STOP })])
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toEqual([])
  })
})

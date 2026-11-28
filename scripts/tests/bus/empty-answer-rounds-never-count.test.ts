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
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, OWNER_WAIT_OPENED, QUESTION_OWNER, REVIEW_ROUNDS_SPENT } from '../../core/events.js'
import { REVIEW_ROUNDS } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { all as pullRequests } from '../../core/pr-readings.js'
import { FAILURES_TO_STOP, queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { cardTransitions } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 2395
const SESSION = 'answer-session-empty'
const HEAD = sha('e')

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

function cardWhoseAnswersLeaveNothing(): Card {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-empty-answer-'))
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
  const answerer: Answerer = async () => ({ session: SESSION, resumed: true, before: HEAD, after: HEAD, owner: null })
  const executor = new AnswerExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => null })
  let decided = 0
  const decide = (): void => {
    decided += 1
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: DECISION_RECORDED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${DECISION_RECORDED}:${decided}`, payload: { source: 'owner', decision_id: 900 + decided, text: `#${CARD}: answer it again`, scope: [CARD] }, legacy: false })
    made.tick()
  }
  return { made, executor, decide, lease: () => leaseNext(made.db, pullRequests(made.db), made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') }
}

describe('empty answer rounds never count toward the review round limit', () => {
  it(`${REVIEW_ROUNDS} empty answers in a row on one head open no owner stop and no faulted-answer wait`, async () => {
    const card = cardWhoseAnswersLeaveNothing()

    const outcomes = []
    for (let round = 1; round <= REVIEW_ROUNDS; round++) {
      outcomes.push(await card.executor.answer(card.lease()!))
      card.decide()
    }

    const stopsAtTheFailureLimit = (round: number): string => round < FAILURES_TO_STOP ? 'queued' : 'stopped'
    expect(outcomes).toEqual(Array.from({ length: REVIEW_ROUNDS }, (_, index) => expect.objectContaining({ kind: 'denied', denial: expect.objectContaining({ reason: 'left_nothing' }) as unknown, next: stopsAtTheFailureLimit(index + 1) })))
    expect(outcomes.at(-1)).toMatchObject({ denial: { detail: expect.stringContaining(`empty answer ${REVIEW_ROUNDS} in a row, which the review round limit ${REVIEW_ROUNDS} does not count`) as unknown } })
    expect(eventsOf(card.made.db, CARD_STOPPED).map(each => each.reason)).not.toContain(QUESTION_OWNER)
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toEqual([])
    expect(eventsOf(card.made.db, REVIEW_ROUNDS_SPENT)).toEqual([])
  })
})

import type { Lease } from '../../core/lease.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { openOwnerWaits } from '../../core/bus-readings.js'
import { appendEvent, openOwnerWait } from '../../core/db.js'
import { CARD_STARTED, CARD_STOPPED, OWNER_WAIT_CLOSED, POLICY_DENIED, QUESTION_AGENT } from '../../core/events.js'
import { AnswerSources } from '../../nodes/answer/duties/source.js'
import { sha } from './github-fake.js'
import { eventsOf, liveBench } from './merge-bench.js'

const PR = 958
const CARD = PR + 100
const OLD_HEAD = sha('0')
const NEW_HEAD = sha('a')

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
})

interface HeldCard {
  bench: MergeBench
  sources: AnswerSources
  answerLease: (head: string) => Lease
  waitsOfTheCard: () => string[]
}

function heldAfterAnEmptyRound(): HeldCard {
  const bench = liveBench()
  benches.push(bench)
  bench.gitHub.open({ number: PR, review: 'success', head: NEW_HEAD })
  const ts = bench.clock.now().toISOString()
  appendEvent(bench.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: `/trees/mc-${CARD}`, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(bench.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: PR, head: OLD_HEAD, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_AGENT, detail: `card #${CARD} asks a question` }, legacy: false })
  appendEvent(bench.db, { ts, type: POLICY_DENIED, actor: 'worker:answer:worker-1', cardId: CARD, pr: PR, head: OLD_HEAD, dedupeKey: `${POLICY_DENIED}:empty-round:${CARD}`, payload: { command: 'answer', kind: 'technical', reason: 'left_nothing', detail: 'an empty round' }, legacy: false })
  const sources = new AnswerSources({ db: bench.db, clock: bench.clock.now })
  const answerLease = (head: string): Lease => ({ taskKey: `answer:${CARD}:${head}`, queue: 'answer', cardId: CARD, pr: PR, head, leaseGen: 1, actor: 'worker:answer:worker-1' })
  expect(sources.sourceOf(answerLease(OLD_HEAD))).toBeNull()
  bench.tick()
  return { bench, sources, answerLease, waitsOfTheCard: () => openOwnerWaits(bench.db).filter(wait => wait.card === CARD).map(wait => wait.text) }
}

describe('the owner wait an empty answer round opens names its own exits', () => {
  it('an empty-round owner wait closes when a new head is observed on the pull request of the card', () => {
    const card = heldAfterAnEmptyRound()

    expect(card.waitsOfTheCard()).toEqual([expect.stringContaining('no answer round runs until a decision bound to the card, an amend or a new head')])
    expect(card.sources.awaitedStop(card.answerLease(OLD_HEAD))).not.toBeNull()
    expect(card.waitsOfTheCard()).toHaveLength(1)

    expect(card.sources.awaitedStop(card.answerLease(NEW_HEAD))).toBeNull()
    card.bench.tick()

    expect(card.waitsOfTheCard()).toEqual([])
    expect(eventsOf(card.bench.db, OWNER_WAIT_CLOSED)).toMatchObject([{ answer: `lifted: a new head ${NEW_HEAD} on pull request #${PR}` }])
  })

  it('the merge of the new head is not denied owner_question_open after an empty-round wait', () => {
    const card = heldAfterAnEmptyRound()

    expect(card.bench.merge(card.bench.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: 'owner_question_open' } })

    card.sources.sourceOf(card.answerLease(NEW_HEAD))
    card.bench.tick()

    expect(card.bench.merge(card.bench.lease()!)).toMatchObject({ kind: 'merged' })
  })

  it('a decision wait of the card opened by another path stays open when the new head lifts the empty round', () => {
    const card = heldAfterAnEmptyRound()
    openOwnerWait(card.bench.db, card.bench.clock.now().toISOString(), 'policy', { need: 'decision', text: 'which path?', card: CARD, request: 7 })
    card.bench.tick()

    card.sources.awaitedStop(card.answerLease(NEW_HEAD))
    card.bench.tick()

    expect(card.waitsOfTheCard()).toEqual(['which path?'])
  })
})

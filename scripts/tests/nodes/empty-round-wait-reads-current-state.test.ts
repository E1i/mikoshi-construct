import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { DeadEndEvents } from '../../supervisor/dead-ends.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { AMEND_SOURCE } from '../../../src/commands/intake/admit.js'
import { openOwnerWaits } from '../../core/card-readings.js'
import { appendEvent, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_RELEASED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, OWNER_WAIT_CLOSED, POLICY_DENIED, QUESTION_AGENT, QUESTION_OWNER, REVIEW_RECORDED, WITNESS_RECORDED } from '../../core/events.js'
import { completeTask, leaseNext } from '../../core/lease.js'
import { all as pullRequests } from '../../core/pr-readings.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { AnswerSources } from '../../nodes/answer/duties/source.js'
import { cardTransitions, waitLiftsTick } from '../../supervisor/composition.js'
import { DEAD_END_ACTOR, DEAD_END_LIFTS, DeadEnds } from '../../supervisor/dead-ends.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from '../bus/github-fake.js'
import { eventsOf, liveBench } from '../bus/merge-bench.js'

const PR = 2210
const CARD = PR + 100
const HEAD = sha('a')
const NEW_HEAD = sha('b')
const DECISION = 781

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
})

interface Card {
  bench: MergeBench
  sources: AnswerSources
  waits: () => string[]
  lease: (head: string, decision?: number) => Lease
  at: () => string
}

function cardText(extra = ''): string {
  return `card: #${CARD} card-${CARD} [implement/construct/M/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nAnswer it.\n${extra}`
}

function aCard(review?: 'success'): Card {
  const bench = liveBench()
  benches.push(bench)
  bench.gitHub.open({ number: PR, head: HEAD, ...(review === undefined ? {} : { review }) })
  const at = (): string => bench.clock.now().toISOString()
  const text = cardText()
  appendEvent(bench.db, { ts: at(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(bench.db, { ts: at(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: `/trees/mc-${CARD}`, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  bench.tick()
  return {
    bench,
    sources: new AnswerSources({ db: bench.db, clock: bench.clock.now }),
    waits: () => openOwnerWaits(bench.db).filter(wait => wait.card === CARD).map(wait => wait.text),
    lease: (head, decision) => ({ taskKey: `answer:${CARD}:${head}${decision === undefined ? '' : `:decision-${decision}`}`, queue: 'answer', cardId: CARD, pr: PR, head, leaseGen: 1, actor: 'worker:answer:worker-1' }),
    at,
  }
}

function stop(card: Card, reason = QUESTION_AGENT): void {
  appendEvent(card.bench.db, { ts: card.at(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason, detail: `card #${CARD} asks a question` }, legacy: false })
  card.bench.tick()
}

function emptyRound(card: Card): void {
  appendEvent(card.bench.db, { ts: card.at(), type: POLICY_DENIED, actor: 'worker:answer:worker-1', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `${POLICY_DENIED}:empty-round:${CARD}`, payload: { command: 'answer', kind: 'technical', reason: 'left_nothing', detail: 'an empty round' }, legacy: false })
  card.bench.tick()
}

function amend(card: Card): void {
  const text = cardText('Amended.\n')
  appendEvent(card.bench.db, { ts: card.at(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:amend:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), source: AMEND_SOURCE }, legacy: false })
  card.bench.tick()
}

function greenWitness(card: Card, head: string): void {
  appendEvent(card.bench.db, { ts: card.at(), type: WITNESS_RECORDED, actor: 'worker:witness:witness-1', cardId: CARD, pr: PR, head, dedupeKey: `${WITNESS_RECORDED}:${PR}:${head}`, payload: { head, verdict: 'green', detail: 'W1 pass' }, legacy: false })
  card.bench.tick()
}

function reviewPass(card: Card, head: string, round = 'first'): void {
  card.bench.gitHub.open({ number: PR, head, review: 'success' })
  appendEvent(card.bench.db, { ts: card.at(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: CARD, pr: PR, head, dedupeKey: `${REVIEW_RECORDED}:${PR}:${head}:${round}`, payload: { head, verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
  card.bench.tick()
}

function takeoverPushReleased(card: Card, head: string): void {
  appendEvent(card.bench.db, { ts: card.at(), type: CARD_RELEASED, actor: 'policy', cardId: CARD, pr: PR, head, dedupeKey: `${CARD_RELEASED}:takeover-push:${CARD}:${head}`, payload: { reason: `takeover pushed ${head}`, takeover: true }, legacy: false })
  card.bench.tick()
}

function decide(card: Card): void {
  appendEvent(card.bench.db, { ts: card.at(), type: DECISION_RECORDED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${DECISION_RECORDED}:${DECISION}`, payload: { source: 'owner', decision_id: DECISION, text: `#${CARD}: merge it`, scope: [CARD] }, legacy: false })
  card.bench.tick()
}

function merges(card: Card): void {
  const lease = card.bench.lease()
  expect(lease).not.toBeNull()
  expect(card.bench.merge(lease!)).toMatchObject({ kind: 'merged' })
}

function nextLease(card: Card, queue: 'answer' | 'review'): Lease | null {
  return leaseNext(card.bench.db, pullRequests(card.bench.db), card.at(), queue, `worker:${queue}:worker-1`)
}

async function theQueuedRoundsRunNoAnswerSession(card: Card): Promise<string[]> {
  let sessions = 0
  const answerer: Answerer = async () => {
    sessions += 1
    return { session: `answer-session-${sessions}`, resumed: true, before: HEAD, after: HEAD, owner: null }
  }
  const trees: CardTreeTools = { home: '/trees', exists: () => true, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: card.bench.db, cards: cardTransitions(), answerer, ownerMerges: () => '', clock: card.bench.clock.now, trees, dirty: () => false, liveSession: () => null })
  const answered: string[] = []
  for (let lease = nextLease(card, 'answer'); lease !== null; lease = nextLease(card, 'answer')) {
    expect(await executor.answer(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'nothing_to_answer' } })
    answered.push(lease.taskKey)
    card.bench.tick()
  }
  for (let lease = nextLease(card, 'review'); lease !== null; lease = nextLease(card, 'review')) {
    completeTask(card.bench.db, cardTransitions(), card.at(), lease, [])
    reviewPass(card, HEAD, lease.taskKey)
  }
  expect(sessions).toBe(0)
  return answered
}

function swept(bench: MergeBench): string[] {
  const lines = waitLiftsTick(bench.db, bench.clock.now).step()
  bench.tick()
  return lines
}

const NOBODY_STUCK: DeadEndEvents = { lastStopReason: () => null, cardsOfUnclosedOwnerWaits: () => [], cardsNobodyHolds: () => [], latestTaskKey: () => null, routedByADecision: () => false, unmergedDependencies: () => [] }

describe('an owner wait over a card is opened from its current state and closes by itself when its condition holds', () => {
  it('an amend before the empty answer round opens no owner wait', () => {
    const card = aCard()
    stop(card)
    amend(card)
    emptyRound(card)

    expect(card.sources.awaitedStop(card.lease(HEAD))).toBeNull()
    card.sources.sourceOf(card.lease(HEAD))
    card.bench.tick()

    expect(card.waits()).toEqual([])
  })

  it('an empty answer round with no amend, new head or decision still opens the owner wait', () => {
    const card = aCard()
    stop(card)
    emptyRound(card)

    expect(card.sources.sourceOf(card.lease(HEAD))).toBeNull()
    card.bench.tick()

    expect(card.waits()).toEqual([expect.stringContaining(`card #${CARD} waits for the owner: an answer round after its ${QUESTION_AGENT} stop left nothing`)])
  })

  it('green witnesses and a review pass on the head close the open empty-round wait', async () => {
    const card = aCard()
    stop(card)
    emptyRound(card)
    card.sources.sourceOf(card.lease(HEAD))
    card.bench.tick()
    expect(card.waits()).toHaveLength(1)

    reviewPass(card, HEAD)
    greenWitness(card, HEAD)
    expect(card.sources.sourceOf(card.lease(HEAD))).toBeNull()
    card.bench.tick()
    swept(card.bench)

    expect(card.waits()).toEqual([])
    expect(eventsOf(card.bench.db, OWNER_WAIT_CLOSED)).toMatchObject([{ answer: `lifted: green witnesses and a review pass on ${HEAD} of pull request #${PR}` }])
    await theQueuedRoundsRunNoAnswerSession(card)
    merges(card)
  })

  it('an owner decision on a card with a review pass and green witnesses on the head queues a merge and no answer session', async () => {
    const card = aCard('success')
    stop(card)
    emptyRound(card)
    reviewPass(card, HEAD)
    greenWitness(card, HEAD)
    const rounds = eventsOf(card.bench.db, POLICY_DENIED).length
    decide(card)

    expect(card.sources.sourceOf(card.lease(HEAD, DECISION))).toBeNull()
    card.bench.tick()

    expect(card.waits()).toEqual([])
    expect(eventsOf(card.bench.db, POLICY_DENIED)).toHaveLength(rounds)
    expect(await theQueuedRoundsRunNoAnswerSession(card)).toContain(`answer:${CARD}:${PR}:${HEAD}:decision-${DECISION}`)
    expect(eventsOf(card.bench.db, POLICY_DENIED).filter(denied => denied.reason === 'left_nothing')).toHaveLength(1)
    merges(card)
  })

  it('a review pass on a new head closes the open dead-end wait through the sweep and queues the merge', () => {
    const card = aCard()
    openOwnerWait(card.bench.db, card.at(), DEAD_END_ACTOR, { need: 'decision', text: `card #${CARD} is at a dead end in state stopped`, card: CARD, pr: PR, lift: { on: DEAD_END_LIFTS, head: HEAD } })
    card.bench.tick()
    expect(card.bench.lease()).toBeNull()

    reviewPass(card, NEW_HEAD)
    expect(new DeadEnds(card.bench.db, card.bench.clock.now, { selecting: () => [], events: NOBODY_STUCK }).step()).toEqual([])
    const lifted = swept(card.bench)

    expect(lifted).toEqual([expect.stringContaining(`lifted: a new head ${NEW_HEAD} on pull request #${PR}`)])
    expect(card.waits()).toEqual([])
    merges(card)
  })

  it('a dead-end wait stays open while no review pass lands after it', () => {
    const card = aCard('success')
    reviewPass(card, HEAD)
    openOwnerWait(card.bench.db, card.at(), DEAD_END_ACTOR, { need: 'decision', text: `card #${CARD} is at a dead end`, card: CARD, pr: PR })
    card.bench.tick()

    expect(new DeadEnds(card.bench.db, card.bench.clock.now, { selecting: () => [], events: NOBODY_STUCK }).step()).toEqual([])
    card.bench.tick()

    expect(card.waits()).toHaveLength(1)
  })

  it('a decision the head already carries after a takeover push and release queues no answer task', () => {
    const card = aCard()
    stop(card, QUESTION_OWNER)
    decide(card)
    card.bench.gitHub.open({ number: PR, head: NEW_HEAD })
    card.bench.tick()
    takeoverPushReleased(card, NEW_HEAD)

    expect(card.sources.sourceOf(card.lease(HEAD, DECISION))).toMatchObject({ kind: 'decision', decisionId: DECISION })
    expect(card.sources.sourceOf(card.lease(NEW_HEAD, DECISION))).toBeNull()
  })

  it('a decision followed by a merge-main head with no takeover release still queues its answer', () => {
    const card = aCard()
    stop(card, QUESTION_OWNER)
    decide(card)
    card.bench.gitHub.open({ number: PR, head: NEW_HEAD })
    card.bench.tick()

    expect(card.sources.sourceOf(card.lease(NEW_HEAD, DECISION))).toMatchObject({ kind: 'decision', decisionId: DECISION })
  })

  it('a takeover release before the decision does not make the head carry it', () => {
    const card = aCard()
    stop(card, QUESTION_OWNER)
    card.bench.gitHub.open({ number: PR, head: NEW_HEAD })
    card.bench.tick()
    takeoverPushReleased(card, NEW_HEAD)
    decide(card)

    expect(card.sources.sourceOf(card.lease(NEW_HEAD, DECISION))).toMatchObject({ kind: 'decision', decisionId: DECISION })
  })
})

describe('a decision is answered unless every merge condition holds on the head it names', () => {
  function decidedWith(pull: { review?: 'success', required?: 'pending' }, witnessed: boolean): Card {
    const card = aCard()
    stop(card)
    emptyRound(card)
    card.bench.gitHub.open({ number: PR, head: HEAD, ...pull })
    if (pull.review === 'success')
      reviewPass(card, HEAD)
    card.bench.gitHub.open({ number: PR, head: HEAD, ...pull })
    card.bench.tick()
    if (witnessed)
      greenWitness(card, HEAD)
    decide(card)
    return card
  }

  it('green CI and a green witness without a review pass still answer the decision', () => {
    const card = decidedWith({}, true)

    expect(card.sources.sourceOf(card.lease(HEAD, DECISION))).toMatchObject({ kind: 'decision', decisionId: DECISION })
  })

  it('a review pass and a green witness with CI not green still answer the decision', () => {
    const card = decidedWith({ review: 'success', required: 'pending' }, true)

    expect(card.sources.sourceOf(card.lease(HEAD, DECISION))).toMatchObject({ kind: 'decision', decisionId: DECISION })
  })

  it('a pull request ready on one head does not lift a decision the lease names on another', () => {
    const card = decidedWith({ review: 'success' }, true)
    greenWitness(card, NEW_HEAD)

    expect(card.sources.sourceOf(card.lease(HEAD, DECISION))).toBeNull()
    expect(card.sources.sourceOf(card.lease(NEW_HEAD, DECISION))).toMatchObject({ kind: 'decision', decisionId: DECISION })
  })

  it('a review pass, green CI and a green witness on the head of a closed pull request still answer the decision', () => {
    const card = decidedWith({ review: 'success' }, true)
    card.bench.gitHub.close(PR, false)
    card.bench.tick()

    expect(pullRequests(card.bench.db).find(pull => pull.pr === PR)).toMatchObject({ head: HEAD, state: 'closed', ci: 'green', verdict_on_head: 'pass' })
    expect(card.sources.sourceOf(card.lease(HEAD, DECISION))).toMatchObject({ kind: 'decision', decisionId: DECISION })
  })
})

describe('the dead-end detector closes no owner wait itself: the sweep of wait-lifts is the one closer', () => {
  function deadEndsStep(card: Card): string[] {
    const lifted = new DeadEnds(card.bench.db, card.bench.clock.now, { selecting: () => [], events: NOBODY_STUCK }).step()
    card.bench.tick()
    return lifted
  }

  it('an owner wait over the pull request that another path opened stays open after a review pass on a new head', () => {
    const card = aCard()
    openOwnerWait(card.bench.db, card.at(), 'policy', { need: 'decision', text: 'which path?', card: CARD, pr: PR })
    card.bench.tick()

    reviewPass(card, NEW_HEAD)

    expect(deadEndsStep(card)).toEqual([])
    expect(card.waits()).toEqual(['which path?'])
  })

  it('a review pass after the dead end on an older head than the observed one keeps the wait', () => {
    const card = aCard()
    openOwnerWait(card.bench.db, card.at(), DEAD_END_ACTOR, { need: 'decision', text: `card #${CARD} is at a dead end`, card: CARD, pr: PR })
    card.bench.tick()

    reviewPass(card, HEAD)
    card.bench.gitHub.open({ number: PR, head: NEW_HEAD, review: 'success' })
    card.bench.tick()

    expect(deadEndsStep(card)).toEqual([])
    expect(card.waits()).toHaveLength(1)
  })

  it('a review pass recorded after the dead end while the observed pull request carries no pass keeps the wait', () => {
    const card = aCard()
    openOwnerWait(card.bench.db, card.at(), DEAD_END_ACTOR, { need: 'decision', text: `card #${CARD} is at a dead end`, card: CARD, pr: PR })
    card.bench.tick()

    appendEvent(card.bench.db, { ts: card.at(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `${REVIEW_RECORDED}:${PR}:${HEAD}:unobserved`, payload: { head: HEAD, verdict: 'pass', reviewer_session: 'reviewer-1', findings: [] }, legacy: false })
    card.bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
    card.bench.tick()

    expect(deadEndsStep(card)).toEqual([])
    expect(card.waits()).toHaveLength(1)
  })

  it('a review recorded with changes on the observed head after the dead end keeps the wait while the observed pull request carries a pass', () => {
    const card = aCard('success')
    openOwnerWait(card.bench.db, card.at(), DEAD_END_ACTOR, { need: 'decision', text: `card #${CARD} is at a dead end`, card: CARD, pr: PR })
    card.bench.tick()

    appendEvent(card.bench.db, { ts: card.at(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: CARD, pr: PR, head: HEAD, dedupeKey: `${REVIEW_RECORDED}:${PR}:${HEAD}:changes`, payload: { head: HEAD, verdict: 'changes', reviewer_session: 'reviewer-1', findings: ['a defect'] }, legacy: false })
    card.bench.gitHub.open({ number: PR, head: HEAD, review: 'success' })
    card.bench.tick()

    expect(pullRequests(card.bench.db).find(pull => pull.pr === PR)).toMatchObject({ head: HEAD, verdict_on_head: 'pass' })
    expect(deadEndsStep(card)).toEqual([])
    expect(card.waits()).toHaveLength(1)
  })
})

const HELD_PR = 958
const HELD_CARD = HELD_PR + 100
const OLD_HEAD = sha('0')
const HELD_NEW_HEAD = sha('a')

interface HeldCard {
  bench: MergeBench
  sources: AnswerSources
  answerLease: (head: string) => Lease
  waitsOfTheCard: () => string[]
}

function heldAfterAnEmptyRound(): HeldCard {
  const bench = liveBench()
  benches.push(bench)
  bench.gitHub.open({ number: HELD_PR, review: 'success', head: HELD_NEW_HEAD })
  const ts = bench.clock.now().toISOString()
  appendEvent(bench.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: HELD_CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${HELD_CARD}`, payload: { session: 'card-session-1', worktree: `/trees/mc-${HELD_CARD}`, branch: `feat/card-${HELD_CARD}`, base: sha('1') }, legacy: false })
  appendEvent(bench.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: HELD_CARD, pr: HELD_PR, head: OLD_HEAD, dedupeKey: `${CARD_STOPPED}:${HELD_CARD}`, payload: { reason: QUESTION_AGENT, detail: `card #${HELD_CARD} asks a question` }, legacy: false })
  appendEvent(bench.db, { ts, type: POLICY_DENIED, actor: 'worker:answer:worker-1', cardId: HELD_CARD, pr: HELD_PR, head: OLD_HEAD, dedupeKey: `${POLICY_DENIED}:empty-round:${HELD_CARD}`, payload: { command: 'answer', kind: 'technical', reason: 'left_nothing', detail: 'an empty round' }, legacy: false })
  const sources = new AnswerSources({ db: bench.db, clock: bench.clock.now })
  const answerLease = (head: string): Lease => ({ taskKey: `answer:${HELD_CARD}:${head}`, queue: 'answer', cardId: HELD_CARD, pr: HELD_PR, head, leaseGen: 1, actor: 'worker:answer:worker-1' })
  expect(sources.sourceOf(answerLease(OLD_HEAD))).toBeNull()
  bench.tick()
  return { bench, sources, answerLease, waitsOfTheCard: () => openOwnerWaits(bench.db).filter(wait => wait.card === HELD_CARD).map(wait => wait.text) }
}

describe('the owner wait an empty answer round opens names its own exits', () => {
  it('an empty-round owner wait closes when a new head is observed on the pull request of the card', () => {
    const card = heldAfterAnEmptyRound()

    expect(card.waitsOfTheCard()).toEqual([expect.stringContaining('no answer round runs until a decision bound to the card, an amend or a new head')])
    expect(card.sources.awaitedStop(card.answerLease(OLD_HEAD))).not.toBeNull()
    expect(card.waitsOfTheCard()).toHaveLength(1)

    expect(card.sources.awaitedStop(card.answerLease(HELD_NEW_HEAD))).toBeNull()
    card.bench.tick()
    swept(card.bench)

    expect(card.waitsOfTheCard()).toEqual([])
    expect(eventsOf(card.bench.db, OWNER_WAIT_CLOSED)).toMatchObject([{ answer: `lifted: a new head ${HELD_NEW_HEAD} on pull request #${HELD_PR}` }])
  })

  it('the pull request is parked while the empty-round wait is open and while its answer is queued, then the new head merges, never denied owner_question_open', () => {
    const card = heldAfterAnEmptyRound()

    expect(card.bench.lease()).toBeNull()

    card.sources.sourceOf(card.answerLease(HELD_NEW_HEAD))
    card.bench.tick()
    swept(card.bench)
    expect(card.bench.lease()).toBeNull()
    const ts = card.bench.clock.now().toISOString()
    completeTask(card.bench.db, cardTransitions(), ts, leaseNext(card.bench.db, pullRequests(card.bench.db), ts, 'answer', 'worker:answer:worker-1')!, [])
    card.bench.tick()

    expect(card.bench.merge(card.bench.lease()!)).toMatchObject({ kind: 'merged' })
    expect(eventsOf(card.bench.db, POLICY_DENIED).filter(denied => denied.reason === 'owner_question_open')).toEqual([])
  })

  it('a decision wait of the card opened by another path stays open when the new head lifts the empty round', () => {
    const card = heldAfterAnEmptyRound()
    openOwnerWait(card.bench.db, card.bench.clock.now().toISOString(), 'policy', { need: 'decision', text: 'which path?', card: HELD_CARD, request: 7 })
    card.bench.tick()

    card.sources.awaitedStop(card.answerLease(HELD_NEW_HEAD))
    card.bench.tick()
    swept(card.bench)

    expect(card.waitsOfTheCard()).toEqual(['which path?'])
  })
})

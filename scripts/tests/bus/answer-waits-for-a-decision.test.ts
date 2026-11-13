import type { OwnerWait } from '../../core/bus-readings.js'
import type { Lease } from '../../core/lease.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { AMEND_SOURCE } from '../../../src/commands/intake/admit.js'
import { openOwnerWaits } from '../../core/bus-readings.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, POLICY_DENIED, QUESTION_AGENT, QUESTION_OWNER } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { AnswerSources } from '../../nodes/answer/duties/source.js'
import { cardDecisionCommand } from '../../policy/shards.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { mergeBench } from './merge-bench.js'

const CARD = 1824
const HEAD = sha('a')

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
  sources: AnswerSources
  sessions: () => number
  lease: () => Lease
}

function cardText(): string {
  return `card: #${CARD} card-${CARD} [implement/construct/M/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
}

function cardStoppedOnAQuestion(reason: string): Card {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-waits-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const ts = made.clock.now().toISOString()
  const text = cardText()
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason, detail: `card #${CARD} waits for the owner on CARD_VERSION` }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  let count = 0
  const answerer: Answerer = async () => {
    count += 1
    return { session: `answer-session-${count}`, resumed: true, before: HEAD, after: HEAD, owner: null }
  }
  const cardTrees: CardTreeTools = { home: trees, exists: () => true, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const parts = { silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => null }
  queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: CARD, stop })
  made.tick()
  return {
    made,
    executor: new AnswerExecutor(parts),
    sources: new AnswerSources(parts),
    sessions: () => count,
    lease: () => leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!,
  }
}

async function afterAnEmptyRound(reason: string): Promise<Card> {
  const card = cardStoppedOnAQuestion(reason)
  expect(await card.executor.answer(card.lease())).toMatchObject({ kind: 'denied', denial: { reason: 'left_nothing' } })
  card.made.tick()
  return card
}

function decide(card: Card, id: number): void {
  appendEvent(card.made.db, { ts: card.made.clock.now().toISOString(), type: DECISION_RECORDED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${DECISION_RECORDED}:${id}`, payload: { source: 'owner', decision_id: id, text: `#${CARD}: the card stays on CARD_VERSION 3`, scope: [CARD] }, legacy: false })
  card.made.tick()
}

function amend(card: Card): void {
  const text = `${cardText()}Amended.\n`
  appendEvent(card.made.db, { ts: card.made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:amend:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), source: AMEND_SOURCE }, legacy: false })
  card.made.tick()
}

describe('an answer round on a card whose question waits for the owner (Z8)', () => {
  it('an answer lease on a card stopped on an open question with no decision since is refused without a session', async () => {
    const card = await afterAnEmptyRound(QUESTION_AGENT)
    const lease = card.lease()

    expect(card.sources.awaitedStop(lease)).toMatchObject({ reason: QUESTION_AGENT })
    const outcome = await card.executor.answer(lease)

    expect(outcome).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'nothing_to_answer' }, next: 'withdrawn' })
    expect(card.sessions()).toBe(1)
  })

  it('a question.owner stop after an empty round waits the same way', async () => {
    const card = cardStoppedOnAQuestion(QUESTION_OWNER)
    const lease = card.lease()
    appendEvent(card.made.db, { ts: card.made.clock.now().toISOString(), type: POLICY_DENIED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${POLICY_DENIED}:empty-round`, payload: { command: 'answer', kind: 'technical', reason: 'left_nothing', detail: 'an empty round' }, legacy: false })

    expect(card.sources.awaitedStop(lease)).toMatchObject({ reason: QUESTION_OWNER })
    expect(card.sources.sourceOf(lease)).toBeNull()
    expect(card.sources.dirtyOnHead(lease)).toBe(false)
  })

  it('the first round on a question stop still runs: only a round after an empty one waits', async () => {
    const card = cardStoppedOnAQuestion(QUESTION_AGENT)

    expect(card.sources.awaitedStop(card.lease())).toBeNull()
  })

  it('a decision on the card after the stop lets the answer round start', async () => {
    const card = await afterAnEmptyRound(QUESTION_AGENT)
    decide(card, 901)

    expect(await card.executor.answer(card.lease())).toMatchObject({ kind: 'denied', denial: { reason: 'left_nothing' } })
    expect(card.sessions()).toBe(2)
  })

  it('an amend of the card or a new head on its pull request lets the answer round start', async () => {
    const amended = await afterAnEmptyRound(QUESTION_AGENT)
    amend(amended)

    expect(amended.sources.awaitedStop(amended.lease())).toBeNull()

    const pushed = await afterAnEmptyRound(QUESTION_AGENT)
    const onTheOldHead = pushed.lease()

    expect(pushed.sources.awaitedStop(onTheOldHead)).not.toBeNull()
    expect(pushed.sources.awaitedStop({ ...onTheOldHead, head: sha('b') })).toBeNull()
  })

  it('a decision bound to another card does not lift the wait', async () => {
    const card = await afterAnEmptyRound(QUESTION_AGENT)
    appendEvent(card.made.db, { ts: card.made.clock.now().toISOString(), type: DECISION_RECORDED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${DECISION_RECORDED}:902`, payload: { source: 'owner', decision_id: 902, text: '#1809: another card', scope: [1809] }, legacy: false })
    card.made.tick()

    expect(card.sources.awaitedStop(card.lease())).not.toBeNull()
  })

  it('a card held this way opens one owner wait for a decision, and a decision on the card closes it', async () => {
    const card = await afterAnEmptyRound(QUESTION_AGENT)
    const waitsOfTheCard = (): OwnerWait[] => openOwnerWaits(card.made.db).filter(wait => wait.card === CARD)

    expect(waitsOfTheCard()).toEqual([])
    const lease = card.lease()
    await card.executor.answer(lease)
    card.made.tick()

    expect(card.sources.sourceOf(lease)).toBeNull()
    expect(waitsOfTheCard()).toMatchObject([{ need: 'decision', command: cardDecisionCommand(CARD), text: expect.stringContaining(`card #${CARD} waits for the owner`) }])
    decide(card, 903)

    expect(waitsOfTheCard()).toEqual([])
  })
})

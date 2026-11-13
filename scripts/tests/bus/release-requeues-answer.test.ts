import type { AnswerOutcome } from '../../nodes/answer/duties/index.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_HELD, CARD_RELEASED, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, QUESTION_AGENT, TASK_FAILED, WINDOW_REQUEST } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'
import { sha } from './github-fake.js'
import { mergeBench } from './merge-bench.js'

const CARD = 907
const HOLD_REASON = 'the owner reads the card before its answer'

const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const UNUSED_REQUEST_TOOLS: RequestTools = {
  treeOf: () => '',
  exists: () => false,
  cutTree: () => {},
  dryRunOf: () => null,
  addDecision: () => ({ code: 1, lines: [] }),
  causeHolds: () => null,
  closePr: () => ({ kind: 'refused', detail: 'unused' }) as never,
  closeDropped: () => [],
}

interface HeldCard {
  made: MergeBench
  trees: string
}

function cardStoppedWithAQuestion(): HeldCard {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-release-answer-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_AGENT, detail: `a question on card #${CARD}` }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_SESSION_ENDED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${CARD}`, payload: { session: 'card-session-1', pgid: 1, stopped: false, detail: 'ended' }, legacy: false })
  return { made, trees }
}

function requested(made: MergeBench, argv: string[]): void {
  requestFromWindow(made.db, made.clock.now().toISOString(), 'window-1', requestOf(argv)!)
}

function requestsApplied(made: MergeBench): string[] {
  return new WindowRequests(made.db, made.clock.now, UNUSED_REQUEST_TOOLS).run().map(outcome => outcome.detail)
}

function executor({ made, trees }: HeldCard, clock: () => Date = made.clock.now): AnswerExecutor {
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const answerer = async () => ({ session: 'card-session-1', resumed: true, before: sha('a'), after: sha('b'), owner: null })
  return new AnswerExecutor({ silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock, trees: cardTrees, dirty: () => false, liveSession: () => null })
}

async function answerRound(card: HeldCard): Promise<AnswerOutcome | null> {
  const lease = leaseNext(card.made.db, card.made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')
  return lease === null ? null : executor(card).answer(lease)
}

function answerStatesOf(made: MergeBench): string[] {
  return (made.db.prepare(`SELECT state FROM tasks WHERE card_id = ? AND queue = 'answer' ORDER BY id`).all(CARD) as { state: string }[]).map(row => row.state)
}

function idOf(made: MergeBench, type: string): number {
  return Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ? AND (card_id = ? OR card_id IS NULL)').get(type, CARD) as { id: number }).id)
}

function heldWithTheReleaseRequested(): HeldCard {
  const card = cardStoppedWithAQuestion()
  requested(card.made, ['hold', '--card', String(CARD), '--reason', HOLD_REASON])
  requestsApplied(card.made)
  requested(card.made, ['release', '--card', String(CARD)])
  card.made.tick()
  return card
}

describe('a release request that wakes the answer node before the release applies', () => {
  it('a release queues the answer the hold withdrew', async () => {
    const card = heldWithTheReleaseRequested()

    expect(await answerRound(card)).toMatchObject({ kind: 'denied', denial: { reason: 'held_for_owner' } })
    expect(answerStatesOf(card.made)).toEqual(['withdrawn'])
    expect(idOf(card.made, TASK_FAILED)).toBeGreaterThan(idOf(card.made, WINDOW_REQUEST))

    expect(requestsApplied(card.made)).toEqual([expect.stringContaining('queued again')])
    expect(idOf(card.made, CARD_RELEASED)).toBeGreaterThan(idOf(card.made, TASK_FAILED))
    expect(answerStatesOf(card.made)).toEqual(['queued'])

    expect(await answerRound(card)).toMatchObject({ kind: 'answered' })
    expect(answerStatesOf(card.made)).toEqual(['completed'])
  })

  it('the answer the release queued again runs once, and a tick queues no second one beside it', async () => {
    const card = heldWithTheReleaseRequested()
    await answerRound(card)
    requestsApplied(card.made)

    card.made.tick()

    expect(answerStatesOf(card.made)).toEqual(['queued'])
  })

  it('a release that leaves a takeover open queues nothing until the takeover is released too', async () => {
    const card = cardStoppedWithAQuestion()
    requested(card.made, ['hold', '--card', String(CARD), '--reason', HOLD_REASON])
    requestsApplied(card.made)
    appendEvent(card.made.db, { ts: card.made.clock.now().toISOString(), type: CARD_HELD, actor: 'owner', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_HELD}:takeover:${CARD}`, payload: { reason: 'the window takes it over', takeover: true }, legacy: false })
    card.made.tick()
    await answerRound(card)

    requested(card.made, ['release', '--card', String(CARD)])
    expect(requestsApplied(card.made)).toEqual([expect.not.stringContaining('queued again')])
    expect(answerStatesOf(card.made)).toEqual(['withdrawn'])

    requested(card.made, ['release', '--card', String(CARD)])
    expect(requestsApplied(card.made)).toEqual([expect.stringContaining('queued again')])
    expect(answerStatesOf(card.made)).toEqual(['queued'])
  })
})

const CLOCK_READINGS_BEFORE_THE_HOLD_IS_READ = 2

function aClockThatReleasesOnceTheHoldIsRead(card: HeldCard): () => Date {
  let readings = 0
  return () => {
    readings += 1
    if (readings === CLOCK_READINGS_BEFORE_THE_HOLD_IS_READ + 1) {
      requested(card.made, ['release', '--card', String(CARD)])
      requestsApplied(card.made)
    }
    return card.made.clock.now()
  }
}

describe('a release that lands between the answer node reading the hold and withdrawing the task', () => {
  it('the answer node queues again the task it withdrew after the release found it leased', async () => {
    const card = cardStoppedWithAQuestion()
    requested(card.made, ['hold', '--card', String(CARD), '--reason', HOLD_REASON])
    requestsApplied(card.made)
    card.made.tick()
    const lease = leaseNext(card.made.db, card.made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!

    expect(await executor(card, aClockThatReleasesOnceTheHoldIsRead(card)).answer(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'held_for_owner' } })
    expect(idOf(card.made, TASK_FAILED)).toBeGreaterThan(idOf(card.made, CARD_RELEASED))

    expect(answerStatesOf(card.made)).toEqual(['queued'])
    expect(await answerRound(card)).toMatchObject({ kind: 'answered' })
  })

  it('a hold that is still open when the task is withdrawn leaves it withdrawn', async () => {
    const card = cardStoppedWithAQuestion()
    requested(card.made, ['hold', '--card', String(CARD), '--reason', HOLD_REASON])
    requestsApplied(card.made)
    requested(card.made, ['release', '--card', String(CARD)])
    requestsApplied(card.made)
    requested(card.made, ['hold', '--card', String(CARD), '--reason', HOLD_REASON])
    requestsApplied(card.made)
    card.made.tick()

    await answerRound(card)

    expect(answerStatesOf(card.made)).toEqual(['withdrawn'])
  })
})

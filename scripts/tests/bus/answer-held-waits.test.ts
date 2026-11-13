import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOLD_RECHECK_MS, LIVE_SESSION_IN_THE_TREE } from '../../core/card-hold.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_ANSWERED, CARD_RELEASED, CARD_STARTED, POLICY_DENIED } from '../../core/events.js'
import { taskKey } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'

const CARD = 1754
const PR = 1654
const SESSION = 'card-session-1'
const PUSHED = sha('e')
const ACTOR = 'worker:answer:worker-1'

afterEach(() => {
  vi.restoreAllMocks()
})

function heldCard() {
  const made = mergeBench()
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-held-'))
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree, { recursive: true })
  const ts = (): string => made.clock.now().toISOString()
  appendEvent(made.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}` }, legacy: false })
  appendEvent(made.db, { ts: ts(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}:${SESSION}`, payload: { session: SESSION, worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  made.gitHub.open({ number: PR, review: 'failure' })
  made.tick()
  let live: string | null = `a live session runs in ${worktree}`
  const answerer = vi.fn<Answerer>(async () => ({ session: SESSION, resumed: true, before: sha('a'), after: PUSHED, owner: null }))
  const cardTrees: CardTreeTools = { home: path.join(trees, 'worktrees'), exists: existsSync, branchOf: () => `feat/card-${CARD}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => live, prepare: () => {}, mergeMain: () => () => ({ kind: 'refused', why: 'no main in the bench' }) })
  return {
    made,
    answerer,
    executor,
    key: taskKey({ queue: 'answer', cardId: CARD, pr: PR, head: sha('a') }),
    lease: () => leaseNext(made.db, ts(), 'answer', ACTOR),
    sessionEnds: () => {
      live = null
    },
    close: () => {
      made.close()
      rmSync(trees, { recursive: true, force: true })
    },
  }
}

describe('an answer held by a live session in the card tree', () => {
  it('an answer held for a live session in the card tree goes once that session ends, with no window step', async () => {
    const card = heldCard()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const held = await card.executor.answer(card.lease()!)

    expect(held).toMatchObject({ kind: 'waiting', taskKey: card.key, reason: LIVE_SESSION_IN_THE_TREE })
    expect(card.answerer).not.toHaveBeenCalled()
    expect(taskState(card.made.db, card.key)).toMatchObject({ state: 'queued', failures: 0 })
    expect(eventsOf(card.made.db, POLICY_DENIED)).toEqual([])
    expect(card.lease()).toBeNull()

    card.sessionEnds()
    card.made.clock.advance(HOLD_RECHECK_MS)
    card.made.tick()
    const again = card.lease()

    expect(again).toMatchObject({ taskKey: card.key })
    expect(await card.executor.answer(again!)).toMatchObject({ kind: 'answered', taskKey: card.key, head: PUSHED })
    expect(card.answerer).toHaveBeenCalledTimes(1)
    expect(eventsOf(card.made.db, CARD_ANSWERED)).toHaveLength(1)
    expect(eventsOf(card.made.db, CARD_RELEASED)).toEqual([])
    expect(eventsOf(card.made.db, BOARD_ALARM)).toEqual([])
    card.close()
  })

  it('a session that outlives the recheck keeps the answer waiting, with no failure counted', async () => {
    const card = heldCard()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    for (let round = 0; round < 4; round += 1) {
      expect(await card.executor.answer(card.lease()!)).toMatchObject({ kind: 'waiting', reason: LIVE_SESSION_IN_THE_TREE })
      card.made.clock.advance(HOLD_RECHECK_MS)
      card.made.tick()
    }

    expect(taskState(card.made.db, card.key)).toMatchObject({ state: 'queued', failures: 0 })
    expect(eventsOf(card.made.db, BOARD_ALARM)).toEqual([])
    expect(card.answerer).not.toHaveBeenCalled()
    card.close()
  })
})

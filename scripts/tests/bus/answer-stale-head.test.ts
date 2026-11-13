import type { Lease } from '../../core/lease.js'
import type { AnswerNodeParts, AnswerStep } from '../../nodes/answer/answer-worker.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, POLICY_DENIED, REVIEW_RECORDED } from '../../core/events.js'
import { taskKey } from '../../core/identifiers.js'
import { leaseNext } from '../../core/lease.js'
import { changesRoundsOf } from '../../core/queue.js'
import { AnswerNode, STALE_ANSWER_HEAD } from '../../nodes/answer/answer-worker.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'

const CARD = 1584
const PR = 1484
const SESSION = 'card-session-1'
const REVIEWED = sha('a')
const FIXED = sha('d')
const ACTOR = 'worker:answer:worker-1'

afterEach(() => {
  vi.restoreAllMocks()
})

class AnswerNodeOnALease extends AnswerNode {
  async step(lease: Lease): Promise<AnswerStep> {
    return this.handle(lease)
  }
}

function reviewedCard() {
  const made = mergeBench()
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-stale-'))
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree, { recursive: true })
  const ts = (): string => made.clock.now().toISOString()
  appendEvent(made.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}` }, legacy: false })
  appendEvent(made.db, { ts: ts(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}:${SESSION}`, payload: { session: SESSION, worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  made.gitHub.open({ number: PR, review: 'failure', head: REVIEWED })
  appendEvent(made.db, { ts: ts(), type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: CARD, pr: PR, head: REVIEWED, dedupeKey: `${REVIEW_RECORDED}:${PR}:${REVIEWED}`, payload: { head: REVIEWED, verdict: 'changes', reviewer_session: 'reviewer-1', findings: ['the fix is missing'] }, legacy: false })
  made.tick()
  const answerer = vi.fn<Answerer>(async () => ({ session: SESSION, resumed: true, before: REVIEWED, after: REVIEWED, owner: null }))
  const cardTrees: CardTreeTools = { home: path.join(trees, 'worktrees'), exists: existsSync, branchOf: () => `feat/card-${CARD}`, recreate: () => {}, bringTo: () => {} }
  const parts: AnswerNodeParts = { silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, session: 'node-1', cardText: () => null, mode: 'live', env: {}, trees: cardTrees }
  return {
    made,
    answerer,
    node: new AnswerNodeOnALease(parts),
    key: taskKey({ queue: 'answer', cardId: CARD, pr: PR, head: REVIEWED }),
    lease: () => leaseNext(made.db, ts(), 'answer', ACTOR),
    close: () => {
      made.close()
      rmSync(trees, { recursive: true, force: true })
    },
  }
}

describe('an answer whose review head the pull request has moved past', () => {
  it('an answer queued for a review head the pull request has moved past is superseded without a session and spends no review round', async () => {
    const card = reviewedCard()
    const lease = card.lease()
    expect(lease).toMatchObject({ taskKey: card.key, head: REVIEWED })
    const rounds = changesRoundsOf(card.made.db, PR)

    card.made.gitHub.open({ number: PR, review: 'failure', head: FIXED })
    card.made.tick()
    const step = await card.node.step(lease!)

    expect(step).toMatchObject({ kind: 'denied', taskKey: card.key, denial: { reason: STALE_ANSWER_HEAD }, next: 'superseded' })
    expect(card.answerer).not.toHaveBeenCalled()
    expect(taskState(card.made.db, card.key).state).toBe('superseded')
    expect(eventsOf(card.made.db, POLICY_DENIED)).toEqual([expect.objectContaining({ command: 'answer', reason: STALE_ANSWER_HEAD })])
    expect(eventsOf(card.made.db, CARD_ANSWERED)).toEqual([])
    expect(changesRoundsOf(card.made.db, PR)).toBe(rounds)
    card.close()
  })

  it('an answer on the head the pull request still stands at is not superseded', async () => {
    const card = reviewedCard()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const step = await card.node.step(card.lease()!)

    expect(step).not.toMatchObject({ denial: { reason: STALE_ANSWER_HEAD } })
    expect(taskState(card.made.db, card.key).state).not.toBe('superseded')
    card.close()
  })
})

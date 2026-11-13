import type { RequestOutcome, RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, QUESTION_AGENT } from '../../core/events.js'
import { failTask, leaseNext } from '../../core/lease.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'
import { sha } from './github-fake.js'
import { mergeBench } from './merge-bench.js'

const CARD = 906
const HOLD_REASON = 'the owner reads the witness downgrade'
const QUEUED_AGAIN = 'queued again'

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
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

function cardWithAQueuedAnswer(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: 'unused', branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_AGENT, detail: `a question on card #${CARD}` }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_SESSION_ENDED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${CARD}`, payload: { session: 'card-session-1', pgid: 1, stopped: false, detail: 'ended' }, legacy: false })
  made.tick()
  return made
}

function request(made: MergeBench, argv: string[]): RequestOutcome {
  requestFromWindow(made.db, made.clock.now().toISOString(), 'window-1', requestOf(argv)!)
  return new WindowRequests(made.db, made.clock.now, UNUSED_REQUEST_TOOLS).run()[0]!
}

function hold(made: MergeBench): RequestOutcome {
  return request(made, ['hold', '--card', String(CARD), '--reason', HOLD_REASON])
}

function release(made: MergeBench): RequestOutcome {
  return request(made, ['release', '--card', String(CARD)])
}

function withdrawAnswer(made: MergeBench, reason: string): void {
  const lease = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!
  failTask(made.db, made.clock.now().toISOString(), lease, { reason, withdraw: true }, SILENT_MS)
}

function answerStatesOf(made: MergeBench): string[] {
  const rows = made.db.prepare(`SELECT state FROM tasks WHERE card_id = ? AND queue = 'answer'`).all(CARD) as { state: string }[]
  return rows.map(row => row.state)
}

describe('the release of a card a plain hold stopped', () => {
  it('a release queues again the answer task a plain hold withdrew', () => {
    const made = cardWithAQueuedAnswer()
    hold(made)
    withdrawAnswer(made, 'held_for_owner')
    expect(answerStatesOf(made)).toEqual(['withdrawn'])

    expect(release(made).detail).toContain(QUEUED_AGAIN)

    expect(answerStatesOf(made)).toEqual(['queued'])
  })

  it('a release leaves an answer task withdrawn for another reason withdrawn', () => {
    const made = cardWithAQueuedAnswer()
    hold(made)
    withdrawAnswer(made, 'nothing_to_answer')

    expect(release(made).detail).not.toContain(QUEUED_AGAIN)

    expect(answerStatesOf(made)).toEqual(['withdrawn'])
  })

  it('a release leaves an answer task withdrawn before the hold opened withdrawn', () => {
    const made = cardWithAQueuedAnswer()
    withdrawAnswer(made, 'held_for_owner')
    hold(made)

    expect(release(made).detail).not.toContain(QUEUED_AGAIN)

    expect(answerStatesOf(made)).toEqual(['withdrawn'])
  })

  it('a second hold on an open hold does not strand the answer the first one withdrew', () => {
    const made = cardWithAQueuedAnswer()
    hold(made)
    withdrawAnswer(made, 'held_for_owner')
    hold(made)

    expect(release(made).detail).toContain(QUEUED_AGAIN)

    expect(answerStatesOf(made)).toEqual(['queued'])
  })

  it('a second release queues nothing: the hold it would answer is closed', () => {
    const made = cardWithAQueuedAnswer()
    hold(made)
    withdrawAnswer(made, 'held_for_owner')
    release(made)
    withdrawAnswer(made, 'held_for_owner')

    expect(release(made).detail).not.toContain(QUEUED_AGAIN)

    expect(answerStatesOf(made)).toEqual(['withdrawn'])
  })
})

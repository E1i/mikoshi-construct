import type { RequestOutcome, RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { HOLD_RECHECK_MS } from '../../core/card-hold.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_HELD, CARD_RELEASED, CARD_STARTED, CARD_TAKEOVER, PR_OPENED } from '../../core/events.js'
import { failTask, leaseNext } from '../../core/lease.js'
import { ownerHoldOf } from '../../nodes/answer/answer-source.js'
import { HELD_FOR_OWNER } from '../../nodes/merge/merge-executor.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { requestFromWindow, requestOf, TAKEOVER_AFTER_MINUTES, WindowRequests } from '../../window/window-requests.js'
import { sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench } from './merge-bench.js'

const PR = 970
const CARD = PR + 100
const MINUTE = 60_000
const REASON = 'the bus has no route for the card'
const TAKEN_HEAD = sha('a')
const PUSHED_HEAD = sha('b')

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

function request(made: MergeBench, argv: string[]): RequestOutcome {
  requestFromWindow(made.db, made.clock.now().toISOString(), 'window-1', requestOf(argv)!)
  return new WindowRequests(made.db, made.clock.now, UNUSED_REQUEST_TOOLS).run()[0]!
}

function startedCard(made: MergeBench): void {
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: 'unused', branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: PR_OPENED, actor: 'worker:shift:shift-1', cardId: CARD, pr: PR, head: null, dedupeKey: `${PR_OPENED}:${CARD}:${PR}`, payload: { pr: PR }, legacy: false })
}

function answerStates(made: MergeBench): { state: string, head: string | null }[] {
  return made.db.prepare(`SELECT state, head FROM tasks WHERE card_id = ? AND queue = 'answer' ORDER BY task_key`).all(CARD) as { state: string, head: string | null }[]
}

function redCardTakenOver(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  startedCard(made)
  made.gitHub.open({ number: PR, head: TAKEN_HEAD, required: 'failure', failed: ['required'] })
  made.tick()
  failTask(made.db, made.clock.now().toISOString(), leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!, { reason: HELD_FOR_OWNER, withdraw: true }, SILENT_MS)
  made.clock.advance(TAKEOVER_AFTER_MINUTES * MINUTE)
  expect(request(made, ['takeover', '--card', String(CARD), '--reason', REASON])).toMatchObject({ kind: 'done' })
  made.tick()
  return made
}

function heldHeads(made: MergeBench): (string | null)[] {
  return (made.db.prepare(`SELECT head FROM events WHERE type = '${CARD_HELD}' AND card_id = ? ORDER BY id`).all(CARD) as { head: string | null }[]).map(row => row.head)
}

describe('a takeover ends at the push', () => {
  it('a push after a takeover releases the card', () => {
    const made = redCardTakenOver()
    expect(heldHeads(made)).toEqual([TAKEN_HEAD])
    expect(ownerHoldOf(made.db, CARD)).toBe(`card #${CARD} is taken over by the window: ${REASON}`)
    expect(eventsOf(made.db, CARD_TAKEOVER)).toHaveLength(1)

    made.gitHub.open({ number: PR, head: PUSHED_HEAD, required: 'failure', failed: ['required'] })
    made.tick()

    expect(eventsOf(made.db, CARD_RELEASED)).toEqual([expect.objectContaining({ request: expect.any(Number) as unknown, reason: `takeover pushed ${PUSHED_HEAD}` })])
    expect(ownerHoldOf(made.db, CARD)).toBeNull()

    made.gitHub.open({ number: PR, head: sha('c'), required: 'failure', failed: ['required'] })
    made.tick()
    expect(eventsOf(made.db, CARD_RELEASED)).toHaveLength(1)
  })

  it('no release on the takeover head or for an owner hold', () => {
    const made = redCardTakenOver()
    expect(heldHeads(made)).toEqual([TAKEN_HEAD])
    made.gitHub.open({ number: PR, head: TAKEN_HEAD, required: 'success' })
    made.tick()
    made.tick()

    expect(eventsOf(made.db, CARD_RELEASED)).toEqual([])
    expect(ownerHoldOf(made.db, CARD)).toBe(`card #${CARD} is taken over by the window: ${REASON}`)

    const owner = mergeBench()
    benches.push(owner)
    startedCard(owner)
    owner.gitHub.open({ number: PR, head: TAKEN_HEAD, required: 'failure', failed: ['required'] })
    owner.tick()
    appendEvent(owner.db, { ts: owner.clock.now().toISOString(), type: CARD_HELD, actor: 'owner', cardId: CARD, pr: null, head: TAKEN_HEAD, dedupeKey: `${CARD_HELD}:owner`, payload: { request: 1, reason: 'the owner reads it first' }, legacy: false })
    owner.tick()
    owner.gitHub.open({ number: PR, head: PUSHED_HEAD, required: 'failure', failed: ['required'] })
    owner.tick()

    expect(eventsOf(owner.db, CARD_RELEASED)).toEqual([])
    expect(ownerHoldOf(owner.db, CARD)).toBe(`card #${CARD} is held for the owner: the owner reads it first`)
  })

  it('a released takeover card gets its answer and merge tasks again', () => {
    const red = redCardTakenOver()
    expect(answerStates(red)).toEqual([{ state: 'withdrawn', head: TAKEN_HEAD }])

    red.gitHub.open({ number: PR, head: PUSHED_HEAD, required: 'failure', failed: ['required'] })
    red.tick()

    expect(answerStates(red).filter(task => task.state === 'queued')).not.toEqual([])
    const answer = leaseNext(red.db, red.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')
    expect(answer).not.toBeNull()
    expect(ownerHoldOf(red.db, CARD)).toBeNull()

    const green = liveBench()
    benches.push(green)
    green.gitHub.open({ number: PR, head: TAKEN_HEAD, review: 'success' })
    green.tick()
    appendEvent(green.db, { ts: green.clock.now().toISOString(), type: CARD_HELD, actor: 'worker:window:window-1', cardId: CARD, pr: null, head: TAKEN_HEAD, dedupeKey: `${CARD_HELD}:request-1`, payload: { request: 1, reason: REASON, takeover: true }, legacy: false })
    green.tick()
    expect(green.merge(green.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: HELD_FOR_OWNER } })

    green.gitHub.open({ number: PR, head: PUSHED_HEAD, review: 'success' })
    green.tick()
    green.clock.advance(HOLD_RECHECK_MS)
    green.tick()

    expect(eventsOf(green.db, CARD_RELEASED)).toEqual([expect.objectContaining({ request: 1, reason: `takeover pushed ${PUSHED_HEAD}` })])
    expect(green.merge(green.lease()!)).toMatchObject({ kind: 'merged' })
  })
})

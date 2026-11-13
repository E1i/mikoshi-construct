import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_HELD, CARD_RELEASED, CARD_STARTED, CARD_STOPPED, PR_OBSERVED, QUESTION_AGENT, WITNESS_RECORDED } from '../../core/events.js'
import { deriveQueues, LAUNCH_STOP_WITH_NO_PULL_REQUEST } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { busProjections } from '../../supervisor/composition.js'
import { sha } from './github-fake.js'

const CARD = 1825
const PR = 1561
const TS = '2026-11-12T10:00:00.000Z'
const HEAD_OF_THE_SESSION = sha('a')
const HEAD_THE_WINDOW_PUSHED = sha('b')

const opened: { db: DatabaseSync, root: string }[] = []

afterEach(() => {
  for (const { db, root } of opened.splice(0)) {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function cardText(touches: string): string {
  return `card: #${CARD} card-${CARD} [implement/construct/M/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
}

function admitted(db: DatabaseSync, key: string, touches: string): void {
  const text = cardText(touches)
  appendEvent(db, { ts: TS, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${key}:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
}

function observed(db: DatabaseSync, head: string, extra: Record<string, unknown> = {}): void {
  appendEvent(db, { ts: TS, type: PR_OBSERVED, actor: 'netwatch', cardId: CARD, pr: PR, head, dedupeKey: `${PR_OBSERVED}:${PR}:${head}:${JSON.stringify(extra)}`, payload: { card_id: CARD, base: 'main', head, mergeable: 'clean', ci: 'green', verdict_on_head: null, auto_merge: false, draft: false, branch: `feat/card-${CARD}`, ...extra }, legacy: false })
}

interface Recorded {
  cardId?: number
  legacy?: boolean
}

function held(db: DatabaseSync, request: number, takeover: boolean, { cardId = CARD, legacy = false }: Recorded = {}): void {
  appendEvent(db, { ts: TS, type: CARD_HELD, actor: 'worker:window:s642', cardId, pr: null, head: null, dedupeKey: `${CARD_HELD}:request-${request}`, payload: { request, reason: 'the bus has no route for the card', ...(takeover ? { takeover: true } : {}) }, legacy })
}

function released(db: DatabaseSync, request: number, { cardId = CARD, legacy = false }: Recorded = {}): void {
  appendEvent(db, { ts: TS, type: CARD_RELEASED, actor: 'worker:window:s642', cardId, pr: null, head: null, dedupeKey: `${CARD_RELEASED}:request-${request}`, payload: { request }, legacy })
}

function cardStoppedAskingToWiden(beforeTheStop: (db: DatabaseSync) => void = () => {}): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-released-takeover-'))
  const db = openBus(path.join(root, 'bus.db'))
  opened.push({ db, root })
  admitted(db, 'body', 'scripts/a.ts')
  appendEvent(db, { ts: TS, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: 'unused', branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  observed(db, HEAD_OF_THE_SESSION)
  beforeTheStop(db)
  appendEvent(db, { ts: TS, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${LAUNCH_STOP_WITH_NO_PULL_REQUEST}${CARD}`, payload: { reason: QUESTION_AGENT, detail: 'outside-touches', widen: ['contract/factory.json'] }, legacy: false })
  admitted(db, 'amend', 'scripts/a.ts, scripts/b.ts')
  return db
}

function cardStoppedAskingToWidenThenHeld(takeover = true): DatabaseSync {
  const db = cardStoppedAskingToWiden()
  held(db, 1, takeover)
  observed(db, HEAD_THE_WINDOW_PUSHED)
  return db
}

function answersAfter(db: DatabaseSync, last: () => void): number {
  last()
  reduce(db, 'pending', busProjections())
  deriveQueues(db, TS)
  return (db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'answer' AND card_id = ? AND head = ?`).get(CARD, HEAD_THE_WINDOW_PUSHED) as { n: number }).n
}

function changesVerdict(db: DatabaseSync): void {
  observed(db, HEAD_THE_WINDOW_PUSHED, { verdict_on_head: 'changes' })
}

function redWitness(db: DatabaseSync): void {
  appendEvent(db, { ts: TS, type: WITNESS_RECORDED, actor: 'worker:witness:1', cardId: CARD, pr: PR, head: HEAD_THE_WINDOW_PUSHED, dedupeKey: `${WITNESS_RECORDED}:${CARD}:${HEAD_THE_WINDOW_PUSHED}`, payload: { head: HEAD_THE_WINDOW_PUSHED, base: sha('1'), verdict: 'red', detail: 'W1 exit:1' }, legacy: false })
}

describe('a card stopped on a question, then taken over and released by the window', () => {
  it('a changes verdict after the release of a takeover queues one answer task', () => {
    const db = cardStoppedAskingToWidenThenHeld()
    released(db, 2)

    expect(answersAfter(db, () => changesVerdict(db))).toBe(1)
    expect(answersAfter(db, () => {})).toBe(1)
  })

  it('a red witness after the release of a takeover queues one answer task', () => {
    const db = cardStoppedAskingToWidenThenHeld()
    released(db, 2)

    expect(answersAfter(db, () => redWitness(db))).toBe(1)
    expect(answersAfter(db, () => {})).toBe(1)
  })

  it('a changes verdict while the takeover still holds the card leaves the question open', () => {
    const db = cardStoppedAskingToWidenThenHeld()

    expect(answersAfter(db, () => changesVerdict(db))).toBe(0)
  })

  it('a plain hold released after the stop does not answer the question', () => {
    const db = cardStoppedAskingToWidenThenHeld(false)
    released(db, 2)

    expect(answersAfter(db, () => changesVerdict(db))).toBe(0)
  })

  it('a takeover taken and released before the stop does not answer the question', () => {
    const db = cardStoppedAskingToWiden((before) => {
      held(before, 1, true)
      released(before, 2)
    })
    observed(db, HEAD_THE_WINDOW_PUSHED)

    expect(answersAfter(db, () => changesVerdict(db))).toBe(0)
  })

  it('a release that precedes the takeover leaves the question open while the takeover holds the card', () => {
    const db = cardStoppedAskingToWiden()
    released(db, 1)
    held(db, 2, true)
    observed(db, HEAD_THE_WINDOW_PUSHED)

    expect(answersAfter(db, () => changesVerdict(db))).toBe(0)
  })

  it('the release of another card does not answer this card\'s question', () => {
    const db = cardStoppedAskingToWidenThenHeld()
    released(db, 2, { cardId: CARD + 1 })

    expect(answersAfter(db, () => changesVerdict(db))).toBe(0)
  })

  it('another card\'s takeover after the stop, then a release of this card, does not answer this card\'s question', () => {
    const db = cardStoppedAskingToWidenThenHeld(false)
    held(db, 2, true, { cardId: CARD + 1 })
    released(db, 3)

    expect(answersAfter(db, () => changesVerdict(db))).toBe(0)
  })

  it('a legacy takeover released after the stop does not answer the question', () => {
    const db = cardStoppedAskingToWiden()
    held(db, 1, true, { legacy: true })
    observed(db, HEAD_THE_WINDOW_PUSHED)
    released(db, 2)

    expect(answersAfter(db, () => changesVerdict(db))).toBe(0)
  })

  it('a legacy release of a takeover leaves the question open', () => {
    const db = cardStoppedAskingToWidenThenHeld()
    released(db, 2, { legacy: true })

    expect(answersAfter(db, () => changesVerdict(db))).toBe(0)
  })
})

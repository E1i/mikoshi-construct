import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_HELD, CARD_STOPPED, MERGE_DONE, OWNER_WAIT_OPENED, QUESTION_AGENT } from '../../core/events.js'
import { deadEndEvents, deadEndParts, openComposedBus } from '../../supervisor/composition.js'
import { DEAD_END_ACTOR, DeadEnds, UNMEASURED_ROUND_MINUTES } from '../../supervisor/dead-ends.js'

const LAST_EVENT_AT = '2026-11-26T08:00:00.000Z'
const ROUND_MS = UNMEASURED_ROUND_MINUTES * 60_000
const PAST_THE_ROUND = new Date(Date.parse(LAST_EVENT_AT) + ROUND_MS + 5 * 60_000)
const CARD = 2319
const DEPENDENCY = 2290
const STARTED = 'started'
const buses: DatabaseSync[] = []
let sequence = 0

afterEach(() => {
  for (const db of buses.splice(0))
    db.close()
})

function bus(): DatabaseSync {
  const db = openComposedBus(':memory:')
  buses.push(db)
  return db
}

function put(db: DatabaseSync, type: string, card: number, payload: Record<string, unknown>, ts = LAST_EVENT_AT, state = 'stopped'): void {
  sequence += 1
  appendEvent(db, { ts, type, actor: 'netwatch', cardId: card, pr: null, head: null, dedupeKey: `fixture:${type}:${sequence}`, payload, legacy: false })
  db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, (SELECT max(id) FROM events)) ON CONFLICT(card_id) DO UPDATE SET event_id = excluded.event_id, state = excluded.state').run(card, state)
}

function stoppedCard(db: DatabaseSync, depends: readonly number[]): void {
  put(db, CARD_ADMITTED, CARD, { card: `#${CARD}`, lane: 'lane-1', text: `card: #${CARD}`, depends })
  put(db, CARD_STOPPED, CARD, { reason: QUESTION_AGENT })
}

function count(db: DatabaseSync, type: string): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ? AND actor = ?').get(type, DEAD_END_ACTOR) as { n: number }).n)
}

function blindDetector(db: DatabaseSync, at: Date): DeadEnds {
  return new DeadEnds(db, () => at, { ...deadEndParts(db), events: { ...deadEndEvents(db), cardsOfUnclosedOwnerWaits: () => [] } })
}

describe('deadEnds reads the same lift conditions as the sweep', () => {
  it('a card waiting on an unmerged dependency or a hold-until is no dead end and a re-raised dead end on the same card is one wait', () => {
    const waiting = bus()
    stoppedCard(waiting, [DEPENDENCY])
    expect(new DeadEnds(waiting, () => PAST_THE_ROUND, deadEndParts(waiting)).step()).toEqual([])
    expect(count(waiting, BOARD_ALARM)).toBe(0)

    const held = bus()
    stoppedCard(held, [])
    put(held, CARD_HELD, CARD, { reason: 'hold until #2290 merges', request: 1 })
    expect(new DeadEnds(held, () => PAST_THE_ROUND, deadEndParts(held)).step()).toEqual([])

    for (const [hold, raises] of [[true, 0], [false, 1]] as const) {
      const started = bus()
      put(started, CARD_ADMITTED, CARD, { card: `#${CARD}`, lane: 'lane-1', text: `card: #${CARD}`, depends: [] }, LAST_EVENT_AT, STARTED)
      if (hold)
        put(started, CARD_HELD, CARD, { reason: 'hold until #2290 merges', request: 1 }, LAST_EVENT_AT, STARTED)
      new DeadEnds(started, () => PAST_THE_ROUND, deadEndParts(started)).step()
      expect([`${STARTED} held ${hold}`, count(started, BOARD_ALARM)]).toEqual([`${STARTED} held ${hold}`, raises])
    }

    const raised = bus()
    stoppedCard(raised, [DEPENDENCY])
    appendEvent(raised, { ts: LAST_EVENT_AT, type: MERGE_DONE, actor: 'netwatch', cardId: DEPENDENCY, pr: null, head: null, dedupeKey: 'fixture:merged-dependency', payload: {}, legacy: false })
    const first = blindDetector(raised, PAST_THE_ROUND).step()
    put(raised, CARD_STOPPED, CARD, { reason: QUESTION_AGENT }, PAST_THE_ROUND.toISOString())
    const again = blindDetector(raised, new Date(PAST_THE_ROUND.getTime() + 2 * ROUND_MS)).step()

    expect(count(raised, BOARD_ALARM)).toBe(2)
    expect(count(raised, OWNER_WAIT_OPENED)).toBe(1)
    const waitOf = (lines: string[]): string | undefined => /owner wait (Q\d+)$/.exec(lines[0] ?? '')?.[1]
    expect(waitOf(again)).toBe(waitOf(first))
  })
})

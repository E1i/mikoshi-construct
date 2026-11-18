import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus, openOwnerWait } from '../../core/db.js'
import { BOARD_ALARM, CARD_HELD, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PR_OBSERVED, QUESTION_OWNER, WITNESS_RECORDED } from '../../core/events.js'
import { deadEndEvents, deadEndParts } from '../../supervisor/composition.js'
import { DEAD_END_ACTOR, DeadEnds, UNMEASURED_ROUND_MINUTES } from '../../supervisor/dead-ends.js'

const LAST_EVENT_AT = '2026-11-18T08:00:00.000Z'
const PAST_THE_ROUND = new Date(Date.parse(LAST_EVENT_AT) + (UNMEASURED_ROUND_MINUTES + 5) * 60_000)
const WITHIN_THE_ROUND = new Date(Date.parse(LAST_EVENT_AT) + (UNMEASURED_ROUND_MINUTES - 5) * 60_000)
const HEAD = 'a'.repeat(40)

interface FixtureEvent {
  type: string
  payload: Record<string, unknown>
}

interface DeadEndShape {
  card: number
  state: string
  events: readonly FixtureEvent[]
  named: string
}

const DEAD_END_SHAPES: Record<string, DeadEndShape> = {
  'red CI with no move': { card: 1975, state: 'in_review', events: [{ type: PR_OBSERVED, payload: { ci: 'red', head: HEAD } }], named: 'in_review' },
  'takeover hold': { card: 1999, state: 'in_review', events: [{ type: CARD_HELD, payload: { takeover: 1, reason: 'window takeover' } }], named: 'in_review' },
  'owner refusal with no route': { card: 2007, state: 'stopped', events: [{ type: CARD_STOPPED, payload: { reason: QUESTION_OWNER } }, { type: OWNER_WAIT_OPENED, payload: { id: 'Q2007', need: 'decision', text: 'go on?' } }, { type: OWNER_WAIT_CLOSED, payload: { id: 'Q2007', answer: 'no', request: 1 } }], named: `stopped (${QUESTION_OWNER})` },
  'owner stop missing answer sessions': { card: 1989, state: 'stopped', events: [{ type: CARD_STOPPED, payload: { reason: QUESTION_OWNER } }], named: `stopped (${QUESTION_OWNER})` },
  'review never queued after a red witness': { card: 2010, state: 'in_review', events: [{ type: WITNESS_RECORDED, payload: { verdict: 'red', head: HEAD } }], named: 'in_review' },
  'held stop on a generated twin': { card: 2004, state: 'stopped', events: [{ type: CARD_STOPPED, payload: { reason: 'conflict', paths: ['contract/module-files.json'] } }], named: 'stopped (conflict)' },
  'ghost session': { card: 2020, state: 'running', events: [{ type: CARD_STARTED, payload: { session: 'ghost-session' } }], named: 'running' },
}

const buses: DatabaseSync[] = []

afterEach(() => {
  for (const bus of buses.splice(0))
    bus.close()
})

function bus(): DatabaseSync {
  const db = openBus(':memory:')
  buses.push(db)
  return db
}

function placed(db: DatabaseSync, shape: DeadEndShape): void {
  let last = 0
  shape.events.forEach((event, index) => {
    appendEvent(db, { ts: LAST_EVENT_AT, type: event.type, actor: 'netwatch', cardId: shape.card, pr: null, head: null, dedupeKey: `fixture:${shape.card}:${index}`, payload: event.payload, legacy: false })
    last = Number((db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
  })
  db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, ?)').run(shape.card, shape.state, last)
}

function alarmsOf(db: DatabaseSync, card: number): string[] {
  return (db.prepare(`SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE type = '${BOARD_ALARM}' AND card_id = ? AND actor = '${DEAD_END_ACTOR}'`).all(card) as { reason: string }[]).map(row => row.reason)
}

function waitsOf(db: DatabaseSync, card: number): string[] {
  return (db.prepare(`SELECT json_extract(payload, '$.text') AS text FROM events WHERE type = '${OWNER_WAIT_OPENED}' AND card_id = ? AND actor = '${DEAD_END_ACTOR}'`).all(card) as { text: string }[]).map(row => row.text)
}

function detector(db: DatabaseSync, at: Date = PAST_THE_ROUND): DeadEnds {
  return new DeadEnds(db, () => at, deadEndParts(db))
}

describe('a fixture card in each dead-end shape raises the dead-end alarm', () => {
  it.each(Object.entries(DEAD_END_SHAPES))('%s raises board.alarm "dead end: …" and one owner wait naming the state', (_, shape) => {
    const db = bus()
    placed(db, shape)
    const lines = detector(db).step()
    expect(lines).toHaveLength(1)
    const [alarm] = alarmsOf(db, shape.card)
    expect(alarm).toMatch(/^dead end: /)
    expect(alarm).toContain(`card #${shape.card} is ${shape.named}`)
    expect(alarm).toContain(`last event ${shape.events.at(-1)!.type}`)
    expect(alarm).toContain(`select a ${shape.named} card`)
    const waits = waitsOf(db, shape.card)
    expect(waits).toHaveLength(1)
    expect(waits[0]).toContain(`dead end in state ${shape.named}`)
  })

  it('a state no node selects is named as such in the alarm', () => {
    const db = bus()
    placed(db, DEAD_END_SHAPES['ghost session']!)
    new DeadEnds(db, () => PAST_THE_ROUND, { moversOf: () => [], events: deadEndEvents(db) }).step()
    expect(alarmsOf(db, 2020)[0]).toContain('no node\'s queue candidates select a running card')
  })
})

describe('a card with a live or queued task, an owner wait or a merge raises no dead-end alarm', () => {
  const shape = DEAD_END_SHAPES['red CI with no move']!

  it('a card with a queued or a leased task is held by its node', () => {
    for (const state of ['queued', 'leased']) {
      const db = bus()
      placed(db, shape)
      db.prepare('INSERT INTO tasks (task_key, queue, card_id, pr, head, state, event_id) VALUES (?, ?, ?, NULL, NULL, ?, 1)').run(`answer:${shape.card}`, 'answer', shape.card, state)
      expect(detector(db).step()).toEqual([])
      expect(alarmsOf(db, shape.card)).toEqual([])
    }
  })

  it('a card with an open owner wait is held by the owner', () => {
    const db = bus()
    placed(db, shape)
    openOwnerWait(db, LAST_EVENT_AT, 'netwatch', { need: 'decision', text: 'route?', card: shape.card })
    expect(detector(db).step()).toEqual([])
  })

  it('a merged card, by its state or by its pull request, is no dead end', () => {
    const byState = bus()
    placed(byState, { ...shape, state: 'merged' })
    expect(detector(byState).step()).toEqual([])
    const byPr = bus()
    placed(byPr, shape)
    byPr.prepare('INSERT INTO prs (pr, card_id, state, event_id) VALUES (?, ?, ?, 1)').run(4242, shape.card, 'merged')
    expect(detector(byPr).step()).toEqual([])
  })

  it('a card idle for less than its round time is no dead end yet', () => {
    const db = bus()
    placed(db, shape)
    expect(detector(db, WITHIN_THE_ROUND).step()).toEqual([])
  })

  it('a dead end is raised once, not on every tick', () => {
    const db = bus()
    placed(db, shape)
    const ends = detector(db)
    expect(ends.step()).toHaveLength(1)
    expect(ends.step()).toEqual([])
    expect(detector(db, new Date(PAST_THE_ROUND.getTime() + 3_600_000)).step()).toEqual([])
    expect(alarmsOf(db, shape.card)).toHaveLength(1)
    expect(waitsOf(db, shape.card)).toHaveLength(1)
  })
})

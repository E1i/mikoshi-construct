import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_TYPES_FOLDED_ON_APPEND, CARDS, DECISIONS, openOwnerWaits, OWNER_WAITS, PROJECTION_TYPES, readCurrent, staleProjection } from '../../core/bus-readings.js'
import { appendedOnCard, CARD_FOLDS, CARDS_PROJECTION } from '../../core/card-automaton.js'
import { appendEvent, openBus, openOwnerWait } from '../../core/db.js'
import { CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, OWNER_WAIT_OPENED, QUESTION_OWNER } from '../../core/events.js'
import { runInbox } from '../../core/inbox.js'
import { OWNER_WAIT_FOLDS, reduce, REDUCED_TYPES, SNAPSHOT } from '../../core/reducer.js'
import { watermarkOf } from '../../core/watermark.js'
import { DECISION_FOLDS, inForceDecisions, recordDecision } from '../../policy/decisions.js'

const TS = '2026-11-09T08:02:45.000Z'
const CARD = 7
const opened: DatabaseSync[] = []

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
})

function bus(): DatabaseSync {
  const db = openBus(':memory:')
  opened.push(db)
  return db
}

function lastId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
}

function waitForTheOwner(db: DatabaseSync): string {
  return openOwnerWait(db, TS, 'policy', { need: 'command', text: 'run it', command: 'pnpm it', card: CARD })
}

function cardStarted(db: DatabaseSync): void {
  appendEvent(db, { ts: TS, type: CARD_STARTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: {}, legacy: false })
}

describe('a reader of a projection behind its events', () => {
  it('owner waits behind its events reads stale', () => {
    const db = bus()
    reduce(db)
    waitForTheOwner(db)
    expect(openOwnerWaits(db)).toEqual([])
    expect(readCurrent(db, [OWNER_WAITS], () => openOwnerWaits(db))).toEqual({ stale: { projection: OWNER_WAITS, type: OWNER_WAIT_OPENED, latest: lastId(db), through: 0 } })
    const out: string[] = []
    expect(runInbox(db, line => out.push(line))).toBe(1)
    expect(out).toEqual([`[bus:inbox] owner_waits is stale: reduced through event 0, behind ${OWNER_WAIT_OPENED} ${lastId(db)}`])
  })

  it('decisions and cards behind their events read stale', () => {
    const db = bus()
    cardStarted(db)
    reduce(db)
    const reduced = watermarkOf(db, SNAPSHOT)
    recordDecision(db, { ts: TS, decisionId: 1, text: 'go on', cards: [] })
    expect(inForceDecisions(db)).toEqual([])
    expect(readCurrent(db, [DECISIONS], () => inForceDecisions(db))).toEqual({ stale: { projection: DECISIONS, type: DECISION_RECORDED, latest: lastId(db), through: reduced } })
    expect(staleProjection(db, CARDS)).toEqual({ projection: CARDS, type: DECISION_RECORDED, latest: lastId(db), through: reduced })
    reduce(db)
    const second = watermarkOf(db, SNAPSHOT)
    appendEvent(db, { ts: TS, type: CARD_STARTED, actor: 'policy', cardId: CARD + 1, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD + 1}`, payload: {}, legacy: false })
    expect(staleProjection(db, CARDS)).toEqual({ projection: CARDS, type: CARD_STARTED, latest: lastId(db), through: second })
    const out: string[] = []
    expect(runInbox(db, line => out.push(line))).toBe(0)
  })

  it('a projection reduced through its latest event answers', () => {
    const db = bus()
    const wait = waitForTheOwner(db)
    cardStarted(db)
    recordDecision(db, { ts: TS, decisionId: 1, text: 'go on', cards: [] })
    reduce(db)
    expect([watermarkOf(db, OWNER_WAITS), watermarkOf(db, DECISIONS)]).toEqual([watermarkOf(db, SNAPSHOT), watermarkOf(db, SNAPSHOT)])
    expect(watermarkOf(db, SNAPSHOT)).toBeGreaterThanOrEqual(3)
    expect(readCurrent(db, [OWNER_WAITS, DECISIONS, CARDS], () => ({ waits: openOwnerWaits(db).map(each => each.id), decisions: inForceDecisions(db).map(each => each.decisionId) })))
      .toEqual({ stale: null, rows: { waits: [wait], decisions: [1] } })
    appendedOnCard(db, { ts: TS, type: CARD_STOPPED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_OWNER }, legacy: false })
    expect(staleProjection(db, CARDS)).toBeNull()
  })

  it('every type a fold of the projection reads is a type its reader checks, and every checked type is reduced', () => {
    const covers = (types: readonly string[], folds: Record<string, unknown>): string[] => Object.keys(folds).filter(type => !types.includes(type))
    expect(covers(PROJECTION_TYPES[OWNER_WAITS], OWNER_WAIT_FOLDS)).toEqual([])
    expect(covers(PROJECTION_TYPES[DECISIONS], DECISION_FOLDS)).toEqual([])
    expect(covers(PROJECTION_TYPES[CARDS], CARD_FOLDS)).toEqual([])
    expect([...CARD_TYPES_FOLDED_ON_APPEND].sort()).toEqual(Object.keys(CARDS_PROJECTION.folds).sort())
    expect(Object.values(PROJECTION_TYPES).flat().filter(type => !REDUCED_TYPES.includes(type))).toEqual([])
  })
})

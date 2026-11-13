import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { busFacts } from '../../../src/commands/board/bus.js'
import { screenLines, waitsLines } from '../../../src/commands/board/screens.js'
import { PLAIN_LORE } from '../../../src/ui/lore.js'
import { CARD_TYPES_FOLDED_ON_APPEND, CARDS, DECISIONS, openOwnerWaits, OWNER_WAITS, PROJECTION_TYPES, readCurrent, staleProjection } from '../../core/bus-readings.js'
import { appendedOnCard, CARD_FOLDS, CARDS_PROJECTION } from '../../core/card-automaton.js'
import { appendEvent, openBus, openOwnerWait } from '../../core/db.js'
import { CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, OWNER_WAIT_OPENED, QUESTION_OWNER } from '../../core/events.js'
import { runInbox } from '../../core/inbox.js'
import { OWNER_WAIT_FOLDS, reduce, reducedTypes, SNAPSHOT } from '../../core/reducer.js'
import { watermarkOf } from '../../core/watermark.js'
import { currentDecisions, DECISION_FOLDS, inForceDecisions, recordDecision } from '../../policy/decisions/index.js'
import { busProjections } from '../../supervisor/composition.js'

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
    reduce(db, 'pending', busProjections())
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
    reduce(db, 'pending', busProjections())
    const reduced = watermarkOf(db, SNAPSHOT)
    recordDecision(db, { ts: TS, decisionId: 1, text: 'go on', cards: [] })
    expect(inForceDecisions(db)).toEqual([])
    expect(currentDecisions(db)).toEqual({ stale: { projection: DECISIONS, type: DECISION_RECORDED, latest: lastId(db), through: reduced } })
    expect(staleProjection(db, CARDS)).toEqual({ projection: CARDS, type: DECISION_RECORDED, latest: lastId(db), through: reduced })
    const staleOut: string[] = []
    expect(runInbox(db, line => staleOut.push(line))).toBe(1)
    expect(staleOut).toEqual([`[bus:inbox] decisions is stale: reduced through event ${reduced}, behind ${DECISION_RECORDED} ${lastId(db)}`])
    const decided = lastId(db)
    reduce(db, 'pending', busProjections())
    expect(currentDecisions(db)).toEqual({ stale: null, rows: [{ decisionId: 1, text: 'go on', cards: [] }], at: decided })
    const second = watermarkOf(db, SNAPSHOT)
    appendEvent(db, { ts: TS, type: CARD_STARTED, actor: 'policy', cardId: CARD + 1, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD + 1}`, payload: {}, legacy: false })
    expect(staleProjection(db, CARDS)).toEqual({ projection: CARDS, type: CARD_STARTED, latest: lastId(db), through: second })
    const out: string[] = []
    expect(runInbox(db, line => out.push(line))).toBe(0)
    expect(out).toEqual(['[bus:inbox] the owner inbox is empty'])
  })

  it('the board marks stale owner waits behind and still reads the last reduced ones', () => {
    const db = bus()
    cardStarted(db)
    reduce(db, 'pending', busProjections())
    waitForTheOwner(db)
    const through = watermarkOf(db, SNAPSHOT)
    const line = `owner_waits shows the last reduced list, behind by ${lastId(db) - through} events and 0 s: reduced through event ${through}, behind ${OWNER_WAIT_OPENED} ${lastId(db)}`
    const facts = busFacts(db, new Date(TS))
    expect([facts.waits, facts.waitsStale]).toEqual([[], line])
    expect(waitsLines(facts, PLAIN_LORE)).toEqual([PLAIN_LORE.boardServiceLine('waits for you', '0', undefined, line)])
    reduce(db, 'pending', busProjections())
    expect(busFacts(db, new Date(TS)).waitsStale).toBeUndefined()
    expect(waitsLines(busFacts(db, new Date(TS)), PLAIN_LORE)).toHaveLength(1)
  })

  it('the board marks stale cards behind and still reads the last reduced ones', () => {
    const db = bus()
    cardStarted(db)
    reduce(db, 'pending', busProjections())
    expect(busFacts(db, new Date(TS)).cardsStale).toBeUndefined()
    const reduced = watermarkOf(db, SNAPSHOT)
    appendEvent(db, { ts: TS, type: CARD_STARTED, actor: 'policy', cardId: CARD + 1, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD + 1}`, payload: {}, legacy: false })
    const line = `cards shows the last reduced list, behind by ${lastId(db) - reduced} events and 0 s: reduced through event ${reduced}, behind ${CARD_STARTED} ${lastId(db)}`
    const facts = busFacts(db, new Date(TS))
    expect([facts.cards, facts.cardsStale]).toEqual([[], line])
    expect(screenLines(facts, PLAIN_LORE).filter(each => each === PLAIN_LORE.boardServiceLine('cards', '0', undefined, line))).toHaveLength(2)
    reduce(db, 'pending', busProjections())
    expect(busFacts(db, new Date(TS)).cardsStale).toBeUndefined()
  })

  it('a projection reduced through its latest event answers', () => {
    const db = bus()
    const wait = waitForTheOwner(db)
    cardStarted(db)
    recordDecision(db, { ts: TS, decisionId: 1, text: 'go on', cards: [] })
    const decided = lastId(db)
    reduce(db, 'pending', busProjections())
    expect([watermarkOf(db, OWNER_WAITS), watermarkOf(db, DECISIONS)]).toEqual([watermarkOf(db, SNAPSHOT), watermarkOf(db, SNAPSHOT)])
    expect(watermarkOf(db, SNAPSHOT)).toBeGreaterThanOrEqual(3)
    expect(readCurrent(db, [OWNER_WAITS, DECISIONS, CARDS], () => ({ waits: openOwnerWaits(db).map(each => each.id), decisions: inForceDecisions(db).map(each => each.decisionId) })))
      .toEqual({ stale: null, rows: { waits: [wait], decisions: [1] }, at: decided })
    appendedOnCard(db, { ts: TS, type: CARD_STOPPED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_OWNER }, legacy: false })
    expect(staleProjection(db, CARDS)).toBeNull()
  })

  it('a reduce marks each projection by its name and none by an empty one', () => {
    const db = bus()
    cardStarted(db)
    reduce(db, 'pending', busProjections())
    const names = (db.prepare('SELECT projection FROM projection_watermarks ORDER BY projection').all() as { projection: string }[]).map(row => row.projection)
    expect(names).toEqual([CARDS, 'chains', DECISIONS, OWNER_WAITS, 'roles', SNAPSHOT, 'tasks'])
  })

  it('every type a fold of the projection reads is a type its reader checks, and every checked type is reduced', () => {
    const covers = (types: readonly string[], folds: Record<string, unknown>): string[] => Object.keys(folds).filter(type => !types.includes(type))
    expect(covers(PROJECTION_TYPES[OWNER_WAITS], OWNER_WAIT_FOLDS)).toEqual([])
    expect(covers(PROJECTION_TYPES[DECISIONS], DECISION_FOLDS)).toEqual([])
    expect(covers(PROJECTION_TYPES[CARDS], CARD_FOLDS)).toEqual([])
    expect([...CARD_TYPES_FOLDED_ON_APPEND].sort()).toEqual(Object.keys(CARDS_PROJECTION.folds).sort())
    expect(Object.values(PROJECTION_TYPES).flat().filter(type => !reducedTypes(busProjections()).includes(type))).toEqual([])
  })
})

import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { reduce } from '../../core/reducer.js'
import { decisionHistory, decisionRows, inForceDecisions, recordDecision, recordedNumbers, startProjectingDecisions } from '../../policy/decisions/index.js'
import { busProjections } from '../../supervisor/composition.js'

const RECORDED_AT = '2026-10-11T16:48:41.490Z'
const SECOND_AT = '2026-10-12T04:27:41.909Z'
const IMPORTED_AT = '2026-11-05T17:26:35.942Z'
const AFTER_THE_CUT = new Date('2026-11-05T18:20:46.056Z')
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

function imported(db: DatabaseSync, key: string, decisions: readonly { decision_id: number, text: string, scope: number[] }[]): void {
  appendEvent(db, { ts: IMPORTED_AT, type: 'decisions.imported', actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: `decisions.imported:${key}`, payload: { decisions }, legacy: false })
  reduce(db, 'pending', busProjections())
}

function eventIdOf(db: DatabaseSync, decisionId: number): number {
  return Number((db.prepare('SELECT id FROM events WHERE dedupe_key = ?').get(`decision.recorded:${decisionId}`) as { id: number }).id)
}

function removeAsTheFoldBefore1604Did(db: DatabaseSync, decisionId: number): void {
  db.prepare('DELETE FROM decisions WHERE decision_id = ?').run(decisionId)
}

function tableRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM decisions ORDER BY decision_id').all().map(row => ({ ...row }))
}

function recordTwo(db: DatabaseSync): void {
  recordDecision(db, { ts: RECORDED_AT, decisionId: 84, text: 'first.', cards: [] })
  recordDecision(db, { ts: SECOND_AT, decisionId: 90, text: 'second.', cards: [841], supersedes: [84] })
  reduce(db, 'pending', busProjections())
}

describe('the history of decisions reads the events', () => {
  it('every recorded decision reads in the history from its own event', () => {
    const db = bus()
    recordTwo(db)
    removeAsTheFoldBefore1604Did(db, 84)

    expect(decisionHistory(db)).toEqual([
      { decisionId: 84, text: 'first.', cards: [], supersedes: [], eventId: eventIdOf(db, 84), recordedAt: RECORDED_AT },
      { decisionId: 90, text: 'second.', cards: [841], supersedes: [84], eventId: eventIdOf(db, 90), recordedAt: SECOND_AT },
    ])
  })

  it('an import leaves the date of a recorded decision as its event wrote it', () => {
    const db = bus()
    recordDecision(db, { ts: RECORDED_AT, decisionId: 84, text: 'first.', cards: [] })
    reduce(db, 'pending', busProjections())
    const before = decisionHistory(db)

    imported(db, 'reworded', [{ decision_id: 84, text: 'first, reworded in the file.', scope: [] }])

    const row = db.prepare('SELECT d.text, d.source, e.ts FROM decisions d JOIN events e ON e.id = d.event_id WHERE d.decision_id = 84').get() as { text: string, source: string, ts: string }
    expect(row).toEqual({ text: 'first, reworded in the file.', source: 'owner-decisions.md', ts: IMPORTED_AT })
    expect(decisionHistory(db)).toEqual(before)
    expect(decisionRows(db).map(decision => decision.recordedAt)).toEqual([RECORDED_AT])
  })

  it('a decision an import leaves out stays in the history and the table keeps it archived', () => {
    const db = bus()
    recordTwo(db)

    imported(db, 'without-both', [{ decision_id: 54, text: 'only in the file.', scope: [] }])

    expect(decisionHistory(db).map(decision => decision.decisionId)).toEqual([84, 90])
    expect(inForceDecisions(db)).toEqual([{ decisionId: 54, text: 'only in the file.', cards: [] }])
    expect(db.prepare('SELECT decision_id, state FROM decisions ORDER BY 1').all().map(row => ({ ...row }))).toEqual([
      { decision_id: 54, state: 'in-force' },
      { decision_id: 84, state: 'archived' },
      { decision_id: 90, state: 'archived' },
    ])
  })

  it('an import that leaves a decision out removes no row, and a rebuild folds the same table', () => {
    const db = bus()
    recordTwo(db)
    imported(db, 'without-both', [{ decision_id: 54, text: 'only in the file.', scope: [] }])
    const table = tableRows(db)

    reduce(db, 'rebuild', busProjections())

    expect(table.map(row => row.decision_id)).toEqual([54, 84, 90])
    expect(tableRows(db)).toEqual(table)
  })

  it('a rebuild gives back a row the fold before #1604 removed and leaves the in-force set as it was', () => {
    const db = bus()
    recordTwo(db)
    imported(db, 'lists-second', [{ decision_id: 90, text: 'second.', scope: [841] }])
    const inForce = inForceDecisions(db)
    removeAsTheFoldBefore1604Did(db, 84)

    reduce(db, 'rebuild', busProjections())

    expect(inForceDecisions(db)).toEqual(inForce)
    expect(tableRows(db).map(row => row.decision_id)).toEqual([84, 90])
  })

  it('the in-force set reads the table, not the history', () => {
    const db = bus()
    recordTwo(db)

    expect(decisionHistory(db).map(decision => decision.decisionId)).toEqual([84, 90])
    expect(inForceDecisions(db)).toEqual([{ decisionId: 90, text: 'second.', cards: [841] }])
  })

  it('an import after the bus projects the file changes neither the table nor the history', () => {
    const db = bus()
    recordTwo(db)
    startProjectingDecisions(db, AFTER_THE_CUT)
    reduce(db, 'pending', busProjections())
    const history = decisionHistory(db)
    const rows = decisionRows(db)

    imported(db, 'after-the-cut', [{ decision_id: 84, text: 'late words.', scope: [] }])

    expect(decisionHistory(db)).toEqual(history)
    expect(decisionRows(db)).toEqual(rows)
  })

  it('a number stays given when its row has left the table, and a number only the file gave stays given too', () => {
    const db = bus()
    recordTwo(db)
    imported(db, 'file-number', [{ decision_id: 54, text: 'only in the file.', scope: [] }])
    removeAsTheFoldBefore1604Did(db, 84)

    expect(recordedNumbers(db).sort((a, b) => a - b)).toEqual([54, 84, 90])
  })

  it('a second event with a number already given is refused by the fold and moves neither the history nor the date', () => {
    const db = bus()
    recordDecision(db, { ts: RECORDED_AT, decisionId: 84, text: 'first.', cards: [] })
    appendEvent(db, { ts: SECOND_AT, type: 'decision.recorded', actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: 'decision.recorded:84:again', payload: { decision_id: 84, text: 'again.', scope: [], source: 'owner' }, legacy: false })
    reduce(db, 'pending', busProjections())

    expect(decisionHistory(db)).toEqual([
      { decisionId: 84, text: 'first.', cards: [], supersedes: [], eventId: eventIdOf(db, 84), recordedAt: RECORDED_AT },
    ])
    expect(decisionRows(db).map(row => [row.number, row.text, row.recordedAt])).toEqual([[84, 'first.', RECORDED_AT]])
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'reducer.rejected'`).get()).toEqual({ n: 1 })
  })

  it('a malformed event between two recorded decisions leaves both of them in the history', () => {
    const db = bus()
    recordDecision(db, { ts: RECORDED_AT, decisionId: 84, text: 'first.', cards: [] })
    appendEvent(db, { ts: RECORDED_AT, type: 'decision.recorded', actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: 'decision.recorded:malformed', payload: { decision_id: 'D-7', text: 'no number.', scope: [], source: 'owner' }, legacy: false })
    recordDecision(db, { ts: SECOND_AT, decisionId: 90, text: 'second.', cards: [] })

    expect(decisionHistory(db).map(decision => decision.decisionId)).toEqual([84, 90])
  })

  it.each([
    ['a word of someone other than the owner', 'netwatch', { decision_id: 7, text: 'forged.', scope: [], source: 'owner' }],
    ['a source other than the owner', 'owner', { decision_id: 7, text: 'forged.', scope: [], source: 'owner-decisions.md' }],
    ['an empty text', 'owner', { decision_id: 7, text: ' ', scope: [], source: 'owner' }],
    ['a decision number that is not a positive integer', 'owner', { decision_id: -7, text: 'no number.', scope: [], source: 'owner' }],
    ['a payload that is not an object', 'owner', 'not json'],
  ])('%s is no decision in the history', (_name, actor, payload) => {
    const db = bus()
    appendEvent(db, { ts: RECORDED_AT, type: 'decision.recorded', actor, cardId: null, pr: null, head: null, dedupeKey: 'decision.recorded:7', payload, legacy: false })

    expect(decisionHistory(db)).toEqual([])
    reduce(db, 'pending', busProjections())
    expect(decisionHistory(db)).toEqual([])
    expect(db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'reducer.rejected'`).get()).toEqual({ n: 1 })
  })
})

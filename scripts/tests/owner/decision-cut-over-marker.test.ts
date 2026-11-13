import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus, openOwnerWait } from '../../core/db.js'
import { DECISIONS_CUT_OVER } from '../../core/events.js'
import { projectionDump, reduce } from '../../core/reducer.js'
import { replayDifferences } from '../../core/report.js'
import { recordDecision } from '../../policy/decisions/index.js'
import { cardDecisionCommand } from '../../policy/shards.js'
import { busProjections } from '../../supervisor/composition.js'

const CARD = 1876
const TS = '2026-11-13T09:30:00.000Z'
const EVENT_COLUMNS = 'id, ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy'

const buses: DatabaseSync[] = []

afterEach(() => {
  buses.splice(0).forEach(db => db.close())
})

function bus(): DatabaseSync {
  const db = openBus(':memory:')
  buses.push(db)
  return db
}

function waitOnTheCard(db: DatabaseSync): string {
  return openOwnerWait(db, TS, 'policy', { need: 'decision', text: 'may it?', command: cardDecisionCommand(CARD), card: CARD })
}

function decide(db: DatabaseSync, decisionId: number, text: string): void {
  recordDecision(db, { decisionId, ts: TS, text: `[owner] ${text}`, cards: [CARD] })
}

function waits(db: DatabaseSync): Record<string, { state: string, answer: string | null }> {
  const rows = db.prepare('SELECT id, state, answer FROM owner_waits ORDER BY id').all() as { id: string, state: string, answer: string | null }[]
  return Object.fromEntries(rows.map(row => [row.id, { state: row.state, answer: row.answer }]))
}

function markers(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(DECISIONS_CUT_OVER) as { n: number }).n)
}

function replayed(from: DatabaseSync): DatabaseSync {
  const into = bus()
  const insert = into.prepare(`INSERT INTO events (${EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const row of from.prepare(`SELECT ${EVENT_COLUMNS} FROM events ORDER BY id`).all() as Record<string, string | number | null>[])
    insert.run(row.id!, row.ts!, row.type!, row.actor!, row.card_id!, row.pr!, row.head!, row.dedupe_key!, row.payload!, row.legacy!)
  reduce(into, 'pending', busProjections())
  return into
}

describe('a decision closes waits by text or card scope only before the bus\'s own cut-over marker', () => {
  it('a rebuilt bus gives the same wait closures as the live one across the cut-over marker', () => {
    const live = bus()
    const before = waitOnTheCard(live)
    decide(live, 1, 'it may')
    reduce(live, 'pending', busProjections())
    expect(markers(live)).toBe(1)
    const after = waitOnTheCard(live)
    decide(live, 2, `${after}: it may`)
    reduce(live, 'pending', busProjections())

    const closures = waits(live)
    expect(closures).toEqual({ [before]: { state: 'closed', answer: 'D-1' }, [after]: { state: 'open', answer: null } })
    const dump = projectionDump(live)

    expect(waits(replayed(live))).toEqual(closures)
    expect(replayDifferences(live, busProjections()).differences).toEqual([])
    reduce(live, 'rebuild', busProjections())
    expect(projectionDump(live)).toBe(dump)
    expect(markers(live)).toBe(1)
  })

  it('on an empty journal the old fold closes nothing', () => {
    const fresh = bus()
    reduce(fresh, 'pending', busProjections())
    expect(markers(fresh)).toBe(1)
    const wait = waitOnTheCard(fresh)
    decide(fresh, 1, `${wait}: it may`)
    reduce(fresh, 'pending', busProjections())

    expect(waits(fresh)).toEqual({ [wait]: { state: 'open', answer: null } })
    expect(markers(fresh)).toBe(1)
  })
})

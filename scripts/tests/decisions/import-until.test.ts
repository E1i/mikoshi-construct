import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { DECISIONS_IMPORTED } from '../../core/events.js'
import { NETWATCH } from '../../core/observations.js'
import { reduce } from '../../core/reducer.js'
import { expireDecisions, inForceDecisions } from '../../policy/decisions/index.js'
import { termInWords } from '../../policy/decisions/read.js'
import { busProjections } from '../../supervisor/composition.js'

const TERM = '2026-11-06T17:04Z'
const BEFORE = '2026-11-06T10:00:00.000Z'
const AFTER = new Date('2026-11-06T18:00:00Z')
const HISTORICAL = [
  { decision_id: 1, text: '[owner] general.', scope: [] },
  { decision_id: 2, text: `[owner] продлеваю D-1 до ${TERM} · until ${TERM}`, scope: [] },
]
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'import-until-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function historicalImport(db: DatabaseSync): void {
  appendEvent(db, { ts: BEFORE, type: DECISIONS_IMPORTED, actor: NETWATCH, cardId: null, pr: null, head: null, dedupeKey: `${DECISIONS_IMPORTED}:historical`, payload: { sha256: 'historical', decisions: HISTORICAL }, legacy: false })
}

function untilOf(db: DatabaseSync, decisionId: number): unknown {
  return (db.prepare('SELECT until FROM decisions WHERE decision_id = ?').get(decisionId) as { until: unknown } | undefined)?.until
}

function inForceNumbers(db: DatabaseSync): number[] {
  return inForceDecisions(db).map(decision => decision.decisionId)
}

describe('a historical decisions.imported event with a term (D-649)', () => {
  it('folds its until into the column and the decision is not in force after the date', () => {
    const db = bus()
    historicalImport(db)
    reduce(db, 'pending', busProjections())
    expect(inForceNumbers(db)).toEqual([1, 2])
    expect(untilOf(db, 2)).toBe(TERM)
    expect(untilOf(db, 1)).toBeNull()

    expireDecisions(db, AFTER)
    reduce(db, 'pending', busProjections())
    expect(inForceNumbers(db)).toEqual([1])
  })

  it('a rebuild over a historical decisions.imported keeps every decision it carried in force', () => {
    const db = bus()
    historicalImport(db)
    reduce(db, 'pending', busProjections())
    expect(inForceNumbers(db)).toEqual([1, 2])
    reduce(db, 'rebuild', busProjections())
    expect(inForceNumbers(db)).toEqual([1, 2])
  })

  it('reads one calendar term after «до» and nothing that is not one', () => {
    expect(termInWords(`продлеваю D-30 до ${TERM}`)).toBe(TERM)
    expect(termInWords('продлеваю D-30 до 2026-11-06')).toBeNull()
    expect(termInWords('до 2026-02-30T10:00Z')).toBeNull()
    expect(termInWords(`до ${TERM}, потом до 2026-11-07T10:00Z`)).toBeNull()
    expect(termInWords(`подо ${TERM}`)).toBeNull()
  })
})

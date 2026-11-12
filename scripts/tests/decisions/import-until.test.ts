import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { reduce } from '../../core/reducer.js'
import { importOwnerDecisions } from '../../policy/decisions/import.js'
import { expireDecisions, inForceDecisions } from '../../policy/decisions/index.js'
import { termInWords } from '../../policy/decisions/read.js'
import { busProjections } from '../../supervisor/composition.js'

const TERM = '2026-11-06T17:04Z'
const BEFORE = '2026-11-06T10:00:00.000Z'
const AFTER = new Date('2026-11-06T18:00:00Z')
const FILE = `# Owner decisions\n\n- D-1 · 2026-11-01 — [owner] general.\n- D-2 · 2026-11-05 — [owner] продлеваю D-1 до ${TERM}\n`
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

function untilOf(db: DatabaseSync, decisionId: number): unknown {
  return (db.prepare('SELECT until FROM decisions WHERE decision_id = ?').get(decisionId) as { until: unknown } | undefined)?.until
}

function inForceNumbers(db: DatabaseSync): number[] {
  return inForceDecisions(db).map(decision => decision.decisionId)
}

describe('a decision imported with a term in its words', () => {
  it('importing a decision with «до <date>» puts until into the column and it is not in force after the date', () => {
    const db = bus()
    expect(importOwnerDecisions(db, FILE, BEFORE)).toBe(true)
    reduce(db, 'pending', busProjections())
    expect(inForceNumbers(db)).toEqual([1, 2])
    expect(untilOf(db, 2)).toBe(TERM)
    expect(untilOf(db, 1)).toBeNull()

    expireDecisions(db, AFTER)
    reduce(db, 'pending', busProjections())
    expect(inForceNumbers(db)).toEqual([1])
  })

  it('an import after the date carries the decision no more', () => {
    const db = bus()
    importOwnerDecisions(db, FILE, AFTER.toISOString())
    reduce(db, 'pending', busProjections())
    expect(inForceNumbers(db)).toEqual([1])
  })

  it('reads one calendar term after «до» and nothing that is not one', () => {
    expect(termInWords(`продлеваю D-30 до ${TERM}`)).toBe(TERM)
    expect(termInWords('продлеваю D-30 до 2026-11-06')).toBeNull()
    expect(termInWords('до 2026-02-30T10:00Z')).toBeNull()
    expect(termInWords(`до ${TERM}, потом до 2026-11-07T10:00Z`)).toBeNull()
    expect(termInWords(`подо ${TERM}`)).toBeNull()
  })
})

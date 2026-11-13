import type { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../../contract/factory/modules.js'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { appendEvent, BUS_DB_VARIABLE, openBus } from '../../../core/db.js'
import { PR_OBSERVED } from '../../../core/events.js'
import { PR_FOLDS, reduce } from '../../../core/reducer.js'

const REDUCER = 'scripts/core/reducer.ts'
const COMPOSITION = 'scripts/supervisor/composition.ts'
const PR = 41
const HEAD = 'a'.repeat(40)
const INTO_COMPOSITION_ROOTS_ON_BASE = 6

let db: DatabaseSync | null = null

afterEach(() => {
  db?.close()
  db = null
})

function busWithOnePrObserved(): DatabaseSync {
  return busWithOnePrObservedAt(':memory:')
}

function busWithOnePrObservedAt(busPath: string): DatabaseSync {
  const bus = openBus(busPath)
  appendEvent(bus, { ts: '2026-11-13T10:00:00.000Z', type: PR_OBSERVED, actor: 'netwatch', cardId: null, pr: PR, head: HEAD, dedupeKey: `${PR_OBSERVED}:${PR}:${HEAD}`, payload: { base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, legacy: false })
  return bus
}

function prRows(bus: DatabaseSync): unknown[] {
  return bus.prepare('SELECT pr, head FROM prs').all().map(row => ({ ...row }))
}

describe('the reducer takes the projections from its caller', () => {
  it('the reducer folds only the projections it is handed', () => {
    db = busWithOnePrObserved()
    expect(reduce(db, 'pending', { folds: [], incremental: [] })).toEqual({ applied: 0, rejected: 0 })
    expect(prRows(db)).toEqual([])
    expect(reduce(db, 'rebuild', { folds: [PR_FOLDS], incremental: [] })).toEqual({ applied: 1, rejected: 0 })
    expect(prRows(db)).toEqual([{ pr: PR, head: HEAD }])
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => from === REDUCER && (to === 'scripts/core/chain.ts' || to === 'scripts/nodes/restart/role.ts'))).toEqual([])
    expect(graph.modules.filter(({ from, to }) => from === 'bus' && to === 'node-restart')).toEqual([])
  })

  it('only a listed process root imports the composition module', () => {
    const report = repositoryReport()
    const admitted = MODULE_GRAPH.composition_imports[COMPOSITION] ?? []
    const importers = report.graph.imports.filter(({ to }) => to === COMPOSITION).map(({ from }) => from)
    expect(importers.length).toBeGreaterThan(0)
    expect(importers.filter(from => !admitted.includes(from))).toEqual([])
    const intoRoots = report.violations.filter(({ reasons }) => reasons.includes('into-composition-root'))
    expect(intoRoots).toHaveLength(INTO_COMPOSITION_ROOTS_ON_BASE)
    expect(intoRoots.filter(({ from, to }) => from === COMPOSITION || to === COMPOSITION)).toEqual([])
  })
  it('bus:reduce, with the reducer as its own process entry, folds through the composition module', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'reducer-entry-'))
    try {
      const busPath = path.join(dir, 'bus.db')
      busWithOnePrObservedAt(busPath).close()
      const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/core/reducer.ts'], { env: { ...process.env, [BUS_DB_VARIABLE]: busPath }, encoding: 'utf8' })
      expect(out).toContain(`${busPath}: applied 1, rejected 0`)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

import type { RunTest } from '../../bus/check-matrix.js'
import type { Graph } from '../../ci/layers.js'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { buildCatalog, writeCatalog } from '../../bus/check-catalog.js'
import { buildMatrix, matrixSummary, runMatrix } from '../../bus/check-matrix.js'
import { openDatabase } from '../../bus/sqlite.js'

const GRAPH: Graph = new Map([
  ['scripts/bus/db.ts', []],
  ['scripts/bus/merge-worker.ts', ['scripts/bus/db.ts']],
  ['scripts/notes/print.ts', []],
  ['scripts/tests/bus/merge-worker.test.ts', ['scripts/bus/merge-worker.ts']],
  ['scripts/tests/notes/print.test.ts', ['scripts/notes/print.ts']],
])

const BRIEF = [
  'mutation m1 scripts/bus/merge-worker.ts: replace `ok = true` with `ok = false` -> scripts/tests/bus/merge-worker.test.ts',
].join('\n')

function catalogDb(briefText: string) {
  const db = openDatabase(':memory:')
  writeCatalog(db, buildCatalog({ graph: GRAPH, testText: () => '', parking: [], briefs: [{ card: 1, text: briefText }], journal: '' }))
  return db
}

function rowsOf(operator: string, killedBy: string | null, layer: string) {
  const db = openDatabase(':memory:')
  writeCatalog(db, {
    tests: [{ test: 'scripts/tests/bus/merge-worker.test.ts', layer: 'bus:merge', kind: 'unit', what: '', witness: '' }],
    mutations: [{ card: 7, id: 'm1', operator, file: 'scripts/bus/merge-worker.ts', layer, killedBy, judged: null }],
  })
  return db
}

const nodeKills: RunTest = (root, test) => spawnSync(process.execPath, [path.join(root, test)]).status !== 0

function tree(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'matrix-'))
  mkdirSync(path.join(root, 'scripts/bus'), { recursive: true })
  mkdirSync(path.join(root, 'scripts/tests/bus'), { recursive: true })
  writeFileSync(path.join(root, 'scripts/bus/merge-worker.ts'), 'export const ok = true\n')
  writeFileSync(path.join(root, 'scripts/tests/bus/merge-worker.test.ts'), 'import { readFileSync } from \'node:fs\'\nimport path from \'node:path\'\nprocess.exit(readFileSync(path.join(import.meta.dirname, \'../../bus/merge-worker.ts\'), \'utf8\').includes(\'ok = true\') ? 0 : 1)\n')
  return root
}

describe('the check matrix built from the catalog rows', () => {
  it('a catalog mutation in a touched layer is killed by its own test', () => {
    const root = tree()
    const db = rowsOf('ok = true → ok = false', 'scripts/tests/bus/merge-worker.test.ts', 'bus:merge')
    const matrix = buildMatrix(['scripts/bus/merge-worker.ts'], GRAPH, () => '', db)
    expect(matrix.layers.map(layer => layer.layer)).toEqual(['bus:merge'])
    expect(matrix.layers[0]!.tests).toEqual(['scripts/tests/bus/merge-worker.test.ts'])
    const results = runMatrix(matrix, root, nodeKills)
    expect(results.map(result => result.outcome)).toEqual(['killed'])
    expect(readFileSync(path.join(root, 'scripts/bus/merge-worker.ts'), 'utf8')).toBe('export const ok = true\n')
    expect(matrixSummary(matrix, results)).toContain('killed #7/m1')
  })

  it('a mutation the test cannot see survives', () => {
    const root = tree()
    const db = rowsOf('ok = true → ok = true ', 'scripts/tests/bus/merge-worker.test.ts', 'bus:merge')
    const matrix = buildMatrix(['scripts/bus/merge-worker.ts'], GRAPH, () => '', db)
    expect(runMatrix(matrix, root, nodeKills).map(result => result.outcome)).toEqual(['survived'])
  })

  it('rows the matrix leaves out carry why', () => {
    const untouched = buildMatrix(['scripts/notes/print.ts'], GRAPH, () => '', rowsOf('a → b', 'scripts/tests/bus/merge-worker.test.ts', 'bus:merge'))
    expect(untouched.skipped.map(entry => entry.why)).toEqual(['its layer is not touched'])
    const unpredicted = buildMatrix(['scripts/bus/merge-worker.ts'], GRAPH, () => '', rowsOf('a → b', null, 'bus:merge'))
    expect(unpredicted.skipped.map(entry => entry.why)).toEqual(['no test predicted to kill it'])
    expect(matrixSummary(unpredicted, [])).toContain('Skipped #7/m1: no test predicted to kill it.')
  })

  it('a path in no layer gives a full run and no matrix', () => {
    const matrix = buildMatrix(['README.md'], GRAPH, () => '', catalogDb(BRIEF))
    expect(matrix.full).not.toBeNull()
    expect(matrixSummary(matrix, [])).toContain('full run')
  })
})

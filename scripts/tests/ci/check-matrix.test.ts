import type { MatrixMutation, RunTest } from '../../bus/check-matrix.js'
import type { Graph } from '../../ci/layers.js'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildCatalog, writeCatalog } from '../../bus/check-catalog.js'
import { buildMatrix, matrixSummary, runMatrix, runMutation } from '../../bus/check-matrix.js'
import { openDatabase } from '../../bus/sqlite.js'

const MATRIX_MODULE = path.resolve(import.meta.dirname, '../../bus/check-matrix.ts')

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

const MERGE_TEST = 'scripts/tests/bus/merge-worker.test.ts'
const MERGE_FILE = 'scripts/bus/merge-worker.ts'
const ORIGINAL = 'export const ok = true\n'

function rowsOf(change: { find: string, replacement: string } | { prose: string }, killedBy: string | null, layer: string) {
  const db = openDatabase(':memory:')
  const [operator, find, replacement] = 'prose' in change ? [change.prose, null, null] : [`${change.find} → ${change.replacement}`, change.find, change.replacement]
  writeCatalog(db, {
    tests: [{ test: MERGE_TEST, layer: 'bus:merge', kind: 'unit', what: '', witness: '' }],
    mutations: [{ card: 7, id: 'm1', operator, file: MERGE_FILE, layer, killedBy, judged: null, find, replacement }],
  })
  return db
}

function mutation(overrides: Partial<MatrixMutation>): MatrixMutation {
  return { card: 7, id: 'm1', file: MERGE_FILE, layer: 'bus:merge', operator: '', find: 'ok = true', replacement: 'ok = false', killedBy: MERGE_TEST, ...overrides }
}

const nodeKills: RunTest = (root, test) => {
  const run = spawnSync(process.execPath, [path.join(root, test)])
  if (run.status === null)
    return 'error'
  return run.status === 0 ? 'passed' : 'failed'
}

function source(root: string): string {
  return readFileSync(path.join(root, MERGE_FILE), 'utf8')
}

function tree(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'matrix-'))
  mkdirSync(path.join(root, 'scripts/bus'), { recursive: true })
  mkdirSync(path.join(root, 'scripts/tests/bus'), { recursive: true })
  writeFileSync(path.join(root, MERGE_FILE), ORIGINAL)
  writeFileSync(path.join(root, 'scripts/tests/bus/merge-worker.test.ts'), 'import { readFileSync } from \'node:fs\'\nimport path from \'node:path\'\nprocess.exit(readFileSync(path.join(import.meta.dirname, \'../../bus/merge-worker.ts\'), \'utf8\').includes(\'ok = true\') ? 0 : 1)\n')
  return root
}

describe('the check matrix built from the catalog rows', () => {
  it('a catalog mutation in a touched layer is killed by its own test', () => {
    const root = tree()
    const db = rowsOf({ find: 'ok = true', replacement: 'ok = false' }, 'scripts/tests/bus/merge-worker.test.ts', 'bus:merge')
    const matrix = buildMatrix(['scripts/bus/merge-worker.ts'], GRAPH, () => '', db)
    expect(matrix.layers.map(layer => layer.layer)).toEqual(['bus:merge'])
    expect(matrix.layers[0]!.tests).toEqual(['scripts/tests/bus/merge-worker.test.ts'])
    const results = runMatrix(matrix, root, nodeKills)
    expect(results.map(result => result.outcome)).toEqual(['killed'])
    expect(source(root)).toBe(ORIGINAL)
    expect(matrixSummary(matrix, results)).toContain('killed #7/m1')
  })

  it('a mutation the test cannot see survives', () => {
    const root = tree()
    const db = rowsOf({ find: 'ok = true', replacement: 'ok = true ' }, 'scripts/tests/bus/merge-worker.test.ts', 'bus:merge')
    const matrix = buildMatrix(['scripts/bus/merge-worker.ts'], GRAPH, () => '', db)
    expect(runMatrix(matrix, root, nodeKills).map(result => result.outcome)).toEqual(['survived'])
  })

  it('rows the matrix leaves out carry why', () => {
    const untouched = buildMatrix(['scripts/notes/print.ts'], GRAPH, () => '', rowsOf({ find: 'a', replacement: 'b' }, 'scripts/tests/bus/merge-worker.test.ts', 'bus:merge'))
    expect(untouched.skipped.map(entry => entry.why)).toEqual(['its layer is not touched'])
    const unpredicted = buildMatrix(['scripts/bus/merge-worker.ts'], GRAPH, () => '', rowsOf({ find: 'a', replacement: 'b' }, null, 'bus:merge'))
    expect(unpredicted.skipped.map(entry => entry.why)).toEqual(['no test predicted to kill it'])
    expect(matrixSummary(unpredicted, [])).toContain('Skipped #7/m1: no test predicted to kill it.')
  })

  it('a path in no layer gives a full run and no matrix', () => {
    const matrix = buildMatrix(['README.md'], GRAPH, () => '', catalogDb(BRIEF))
    expect(matrix.full).not.toBeNull()
    expect(matrixSummary(matrix, [])).toContain('full run')
  })
  it('a test already red on the unmutated file is not run, and no kill is counted', () => {
    const root = tree()
    writeFileSync(path.join(root, MERGE_FILE), 'export const ok = maybe\n')
    const result = runMutation(root, mutation({ find: 'ok = maybe', replacement: 'ok = false' }), nodeKills)
    expect(result).toMatchObject({ outcome: 'not-run', why: 'its test is red on the unmutated file' })
  })

  it('a test file that no longer exists is not run and the source is left as it was', () => {
    const root = tree()
    rmSync(path.join(root, MERGE_TEST))
    expect(runMutation(root, mutation({}), nodeKills)).toMatchObject({ outcome: 'not-run', why: 'its test file does not exist' })
    expect(source(root)).toBe(ORIGINAL)
  })

  it('a test that fails to start under the mutation is not run, not killed', () => {
    const root = tree()
    let runs = 0
    const startsOnlyOnce: RunTest = (at, test) => (runs++ === 0 ? nodeKills(at, test) : 'error')
    expect(runMutation(root, mutation({}), startsOnlyOnce)).toMatchObject({ outcome: 'not-run', why: 'its test did not run' })
    expect(source(root)).toBe(ORIGINAL)
  })

  it('an interrupted test run stops the matrix and leaves the rest not run', () => {
    const root = tree()
    const matrix = { full: null, layers: [{ layer: 'bus:merge', tests: [MERGE_TEST], mutations: [mutation({ id: 'm1' }), mutation({ id: 'm2' })] }], skipped: [] }
    let runs = 0
    const interruptedUnderMutation: RunTest = (at, test) => (runs++ === 0 ? nodeKills(at, test) : 'interrupted')
    expect(runMatrix(matrix, root, interruptedUnderMutation).map(result => result.why)).toEqual(['the run was interrupted', 'the run was interrupted'])
    expect(runs).toBe(2)
    expect(source(root)).toBe(ORIGINAL)
  })

  it('a prose operator with an arrow in it is never written into the file', () => {
    const root = tree()
    const prose = 'ok = true → flip the flag'
    const matrix = buildMatrix([MERGE_FILE], GRAPH, () => '', rowsOf({ prose }, MERGE_TEST, 'bus:merge'))
    expect(matrix.skipped.map(entry => entry.why)).toEqual(['not a find and replace line'])
    expect(runMutation(root, mutation({ operator: prose, find: null, replacement: null }), nodeKills).outcome).toBe('not-run')
    expect(source(root)).toBe(ORIGINAL)
  })

  it('a find text that itself holds an arrow is replaced whole', () => {
    const root = tree()
    writeFileSync(path.join(root, MERGE_FILE), 'export const ok = true\nexport const label = \'a → b\'\n')
    let seen = ''
    const reads: RunTest = (at, test) => {
      seen = source(at)
      return nodeKills(at, test)
    }
    runMutation(root, mutation({ find: '\'a → b\'', replacement: '\'c\'' }), reads)
    expect(seen).toBe('export const ok = true\nexport const label = \'c\'\n')
  })

  it('a mutation whose file or test resolves outside the tree is not run', () => {
    const root = tree()
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.ts`)
    writeFileSync(outside, ORIGINAL)
    const escaping = path.relative(root, outside)
    expect(runMutation(root, mutation({ file: escaping }), nodeKills)).toMatchObject({ outcome: 'not-run', why: 'its file or its test is outside the tree' })
    expect(runMutation(root, mutation({ killedBy: escaping }), nodeKills)).toMatchObject({ outcome: 'not-run', why: 'its file or its test is outside the tree' })
    expect(readFileSync(outside, 'utf8')).toBe(ORIGINAL)
  })

  it('a SIGTERM during the mutated run exits only after the file is restored', () => {
    const terminatedDuringMutation = (hold: boolean) => {
      const root = tree()
      const script = path.join(root, 'terminate.ts')
      writeFileSync(script, [
        `import { holdSignalsUntilRestored, runMutation } from ${JSON.stringify(pathToFileURL(MATRIX_MODULE).href)}`,
        hold ? 'holdSignalsUntilRestored()' : '',
        'let runs = 0',
        `runMutation(${JSON.stringify(root)}, ${JSON.stringify(mutation({}))}, () => {`,
        '  if (runs++ === 1)',
        '    process.kill(process.pid, \'SIGTERM\')',
        '  return \'passed\'',
        '})',
      ].join('\n'))
      const run = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: path.resolve(import.meta.dirname, '../../..') })
      return { run, source: source(root) }
    }
    const unheld = terminatedDuringMutation(false)
    expect(unheld.run.signal).toBe('SIGTERM')
    expect(unheld.source).toBe('export const ok = false\n')
    const held = terminatedDuringMutation(true)
    expect(held.run.status).toBe(143)
    expect(held.source).toBe(ORIGINAL)
  })
})

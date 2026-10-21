import type { Matrix, MatrixMutation, MatrixResult, RunTest } from '../../bus/check-matrix.js'
import type { Graph } from '../../ci/layers.js'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { busReaderAt } from '../../../src/commands/board/bus.js'
import { buildCatalog, writeCatalog } from '../../bus/check-catalog.js'
import { appendMatrix, buildMatrix, matrixArguments, matrixSummary, runMatrix, runMutation } from '../../bus/check-matrix.js'
import { openBus } from '../../bus/db.js'
import { openDatabase } from '../../bus/sqlite.js'
import { CHECKS_MATRIX_EVENT } from '../../core/events.js'

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
  it('a catalog mutation in a touched layer is killed by its own test', async () => {
    const root = tree()
    const db = rowsOf({ find: 'ok = true', replacement: 'ok = false' }, 'scripts/tests/bus/merge-worker.test.ts', 'bus:merge')
    const matrix = buildMatrix(['scripts/bus/merge-worker.ts'], GRAPH, () => '', db)
    expect(matrix.layers.map(layer => layer.layer)).toEqual(['bus:merge'])
    expect(matrix.layers[0]!.tests).toEqual(['scripts/tests/bus/merge-worker.test.ts'])
    const results = await runMatrix(matrix, root, nodeKills)
    expect(results.map(result => result.outcome)).toEqual(['killed'])
    expect(source(root)).toBe(ORIGINAL)
    expect(matrixSummary(matrix, results)).toContain('killed #7/m1')
  })

  it('a mutation the test cannot see survives', async () => {
    const root = tree()
    const db = rowsOf({ find: 'ok = true', replacement: 'ok = true ' }, 'scripts/tests/bus/merge-worker.test.ts', 'bus:merge')
    const matrix = buildMatrix(['scripts/bus/merge-worker.ts'], GRAPH, () => '', db)
    expect((await runMatrix(matrix, root, nodeKills)).map(result => result.outcome)).toEqual(['survived'])
  })

  it('rows the matrix leaves out carry why', async () => {
    const untouched = buildMatrix(['scripts/notes/print.ts'], GRAPH, () => '', rowsOf({ find: 'a', replacement: 'b' }, 'scripts/tests/bus/merge-worker.test.ts', 'bus:merge'))
    expect(untouched.skipped.map(entry => entry.why)).toEqual(['its layer is not touched'])
    const unpredicted = buildMatrix(['scripts/bus/merge-worker.ts'], GRAPH, () => '', rowsOf({ find: 'a', replacement: 'b' }, null, 'bus:merge'))
    expect(unpredicted.skipped.map(entry => entry.why)).toEqual(['no test predicted to kill it'])
    expect(matrixSummary(unpredicted, [])).toContain('Skipped #7/m1: no test predicted to kill it.')
  })

  it('a path in no layer gives a full run and no matrix', async () => {
    const matrix = buildMatrix(['README.md'], GRAPH, () => '', catalogDb(BRIEF))
    expect(matrix.full).not.toBeNull()
    expect(matrixSummary(matrix, [])).toContain('full run')
  })
  it('a test already red on the unmutated file is not run, and no kill is counted', async () => {
    const root = tree()
    writeFileSync(path.join(root, MERGE_FILE), 'export const ok = maybe\n')
    const result = await runMutation(root, mutation({ find: 'ok = maybe', replacement: 'ok = false' }), nodeKills)
    expect(result).toMatchObject({ outcome: 'not-run', why: 'its test is red on the unmutated file' })
  })

  it('a test file that no longer exists is not run and the source is left as it was', async () => {
    const root = tree()
    rmSync(path.join(root, MERGE_TEST))
    expect(await runMutation(root, mutation({}), nodeKills)).toMatchObject({ outcome: 'not-run', why: 'its test file does not exist' })
    expect(source(root)).toBe(ORIGINAL)
  })

  it('a test that fails to start under the mutation is not run, not killed', async () => {
    const root = tree()
    let runs = 0
    const startsOnlyOnce: RunTest = (at, test, signal) => (runs++ === 0 ? nodeKills(at, test, signal) : 'error')
    expect(await runMutation(root, mutation({}), startsOnlyOnce)).toMatchObject({ outcome: 'not-run', why: 'its test did not run' })
    expect(source(root)).toBe(ORIGINAL)
  })

  it('an interrupted test run stops the matrix and leaves the rest not run', async () => {
    const root = tree()
    const matrix = { full: null, layers: [{ layer: 'bus:merge', tests: [MERGE_TEST], mutations: [mutation({ id: 'm1' }), mutation({ id: 'm2' })] }], skipped: [] }
    let runs = 0
    const interruptedUnderMutation: RunTest = (at, test, signal) => (runs++ === 0 ? nodeKills(at, test, signal) : 'interrupted')
    expect((await runMatrix(matrix, root, interruptedUnderMutation)).map(result => result.why)).toEqual(['the run was interrupted', 'the run was interrupted'])
    expect(runs).toBe(2)
    expect(source(root)).toBe(ORIGINAL)
  })

  it('a prose operator with an arrow in it is never written into the file', async () => {
    const root = tree()
    const prose = 'ok = true → flip the flag'
    const matrix = buildMatrix([MERGE_FILE], GRAPH, () => '', rowsOf({ prose }, MERGE_TEST, 'bus:merge'))
    expect(matrix.skipped.map(entry => entry.why)).toEqual(['not a find and replace line'])
    expect((await runMutation(root, mutation({ operator: prose, find: null, replacement: null }), nodeKills)).outcome).toBe('not-run')
    expect(source(root)).toBe(ORIGINAL)
  })

  it('a find text that itself holds an arrow is replaced whole', async () => {
    const root = tree()
    writeFileSync(path.join(root, MERGE_FILE), 'export const ok = true\nexport const label = \'a → b\'\n')
    let seen = ''
    const reads: RunTest = (at, test, signal) => {
      seen = source(at)
      return nodeKills(at, test, signal)
    }
    await runMutation(root, mutation({ find: '\'a → b\'', replacement: '\'c\'' }), reads)
    expect(seen).toBe('export const ok = true\nexport const label = \'c\'\n')
  })

  it('a mutation whose file or test resolves outside the tree is not run', async () => {
    const root = tree()
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.ts`)
    writeFileSync(outside, ORIGINAL)
    const escaping = path.relative(root, outside)
    expect(await runMutation(root, mutation({ file: escaping }), nodeKills)).toMatchObject({ outcome: 'not-run', why: 'its file or its test is outside the tree' })
    expect(await runMutation(root, mutation({ killedBy: escaping }), nodeKills)).toMatchObject({ outcome: 'not-run', why: 'its file or its test is outside the tree' })
    expect(readFileSync(outside, 'utf8')).toBe(ORIGINAL)
  })

  it('a SIGTERM to the matrix process alone while its test child runs restores the file before it exits', async () => {
    const terminatedWhileTestRuns = async (hold: boolean) => {
      const root = tree()
      const script = path.join(root, 'terminate.mts')
      writeFileSync(script, [
        'import { spawn } from \'node:child_process\'',
        `import { holdSignalsUntilRestored, MutationGuard, runMutation } from ${JSON.stringify(pathToFileURL(MATRIX_MODULE).href)}`,
        'const guard = new MutationGuard()',
        hold ? 'holdSignalsUntilRestored(guard)' : '',
        'let runs = 0',
        `await runMutation(${JSON.stringify(root)}, ${JSON.stringify(mutation({}))}, async (_root, _test, signal) => {`,
        '  if (runs++ === 0)',
        '    return \'passed\'',
        '  const child = spawn(process.execPath, [\'-e\', \'setTimeout(() => {}, 30000)\'], { stdio: \'ignore\', signal })',
        '  child.once(\'error\', () => {})',
        '  console.log(\'mutated\')',
        '  await new Promise(resolve => child.once(\'close\', resolve))',
        '  return \'failed\'',
        '}, guard)',
      ].join('\n'))
      const matrix = spawn(process.execPath, ['--import', 'tsx', script], { cwd: path.resolve(import.meta.dirname, '../../..'), stdio: ['ignore', 'pipe', 'inherit'] })
      await new Promise<void>(resolve => matrix.stdout.setEncoding('utf8').on('data', (chunk: string) => chunk.includes('mutated') && resolve()))
      matrix.kill('SIGTERM')
      const [status, signal] = await once(matrix, 'exit') as [number | null, NodeJS.Signals | null]
      return { status, signal, source: source(root) }
    }
    const unheld = await terminatedWhileTestRuns(false)
    expect(unheld.signal).toBe('SIGTERM')
    expect(unheld.source).toBe('export const ok = false\n')
    const held = await terminatedWhileTestRuns(true)
    expect(held.status).toBe(143)
    expect(held.source).toBe(ORIGINAL)
  }, 30000)

  it('a catalog written before find and replace were recorded builds a matrix that names the refill', async () => {
    const db = openDatabase(':memory:')
    db.exec('CREATE TABLE check_tests (test TEXT PRIMARY KEY, layer TEXT NOT NULL, kind TEXT NOT NULL, what TEXT NOT NULL, witness TEXT NOT NULL)')
    db.exec('CREATE TABLE check_mutations (card INTEGER NOT NULL, id TEXT NOT NULL, operator TEXT NOT NULL, file TEXT NOT NULL, layer TEXT NOT NULL, killed_by TEXT, judged TEXT, PRIMARY KEY (card, id))')
    db.prepare('INSERT INTO check_mutations (card, id, operator, file, layer, killed_by, judged) VALUES (?, ?, ?, ?, ?, ?, ?)').run(7, 'm1', 'ok = true → ok = false', MERGE_FILE, 'bus:merge', MERGE_TEST, null)
    const matrix = buildMatrix([MERGE_FILE], GRAPH, () => '', db)
    expect(matrix.skipped.map(entry => entry.why)).toEqual(['the catalog predates its find and replace columns; refill it'])
    expect(matrix.layers.flatMap(layer => layer.mutations)).toEqual([])
  })
})

const BUS_HEAD = 'a'.repeat(40)
const BUS_TS = '2026-10-20T10:00:00.000Z'

function busFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'check-matrix-bus-')), 'bus.db')
}

interface MatrixEventRow { type: string, actor: string, card_id: number | null, pr: number, head: string | null, payload: string }

function matrixEvents(db: ReturnType<typeof openBus>): MatrixEventRow[] {
  return db.prepare('SELECT type, actor, card_id, pr, head, payload FROM events ORDER BY id').all() as unknown as MatrixEventRow[]
}

describe('checks:matrix and the bus', () => {
  it('checks:matrix appends its matrix for a PR to the bus', () => {
    const [m1, m2, m3] = [mutation({ id: 'm1' }), mutation({ id: 'm2' }), mutation({ id: 'm3' })]
    const matrix: Matrix = { full: null, layers: [{ layer: 'bus:merge', tests: [MERGE_TEST], mutations: [m1, m2, m3] }], skipped: [{ mutation: mutation({ id: 'm4' }), why: 'no test predicted to kill it' }] }
    const results: MatrixResult[] = [
      { mutation: m1, outcome: 'killed', why: null },
      { mutation: m2, outcome: 'survived', why: null },
      { mutation: m3, outcome: 'not-run', why: 'its test did not run' },
    ]
    const file = busFile()
    const db = openBus(file)
    expect(appendMatrix(db, { pr: 922, head: BUS_HEAD }, matrix, results, BUS_TS, 'test')).toBe(true)
    const [row] = matrixEvents(db)
    db.close()
    expect(row).toMatchObject({ type: CHECKS_MATRIX_EVENT, actor: 'worker:checks-matrix:test', card_id: null, pr: 922, head: BUS_HEAD })
    expect(JSON.parse(row!.payload)).toEqual({ full: null, killed: 1, survived: 1, notRun: 1, skipped: 1, summary: matrixSummary(matrix, results) })
    const reading = busReaderAt(file)()
    expect(reading.status === 'read' && reading.facts.matrices).toEqual([{ pr: 922, head: BUS_HEAD, full: null, killed: 1, survived: 1, notRun: 1 }])
  })

  it('a second matrix for the same PR head is not appended twice, and one for a full run carries its reason', () => {
    const full: Matrix = { full: 'the change touches the harness', layers: [], skipped: [] }
    const db = openBus(busFile())
    expect(appendMatrix(db, { pr: 9, head: BUS_HEAD }, full, [], BUS_TS, 'test')).toBe(true)
    expect(appendMatrix(db, { pr: 9, head: BUS_HEAD }, full, [], '2026-10-20T11:00:00.000Z', 'test')).toBe(false)
    expect(appendMatrix(db, { pr: 9, head: null }, full, [], BUS_TS, 'test')).toBe(true)
    expect(matrixEvents(db).map(row => JSON.parse(row.payload).full)).toEqual(['the change touches the harness', 'the change touches the harness'])
    db.close()
  })

  it('reads the PR and head from its flags and the changed files from the rest, and refuses a malformed flag', () => {
    expect(matrixArguments(['a.ts', 'b.ts'])).toEqual({ changed: ['a.ts', 'b.ts'], target: null })
    expect(matrixArguments(['--pr', '922', '--head', BUS_HEAD, 'a.ts'])).toEqual({ changed: ['a.ts'], target: { pr: 922, head: BUS_HEAD } })
    expect(matrixArguments(['--pr', '922', 'a.ts'])).toEqual({ changed: ['a.ts'], target: { pr: 922, head: null } })
    expect(() => matrixArguments(['--pr', 'x'])).toThrow('--pr is not a positive integer: x')
    expect(() => matrixArguments(['--pr', '1', '--head', 'abc'])).toThrow('--head is not a full sha: abc')
    expect(() => matrixArguments(['--head', BUS_HEAD])).toThrow('--head needs --pr')
  })
})

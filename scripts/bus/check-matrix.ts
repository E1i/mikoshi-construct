import type { DatabaseSync } from 'node:sqlite'
import type { Graph } from '../ci/layers.js'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { selectRun } from '../ci/layers.js'
import { cruise } from '../ci/select.js'
import { missingMutationColumns } from './check-catalog.js'
import { defaultBusPath } from './db.js'
import { openDatabase } from './sqlite.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const HELD_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

export interface MatrixMutation { card: number, id: string, file: string, layer: string, operator: string, find: string | null, replacement: string | null, killedBy: string | null }

export type SkipReason = 'no test predicted to kill it' | 'not a find and replace line' | 'its layer is not touched' | 'the catalog predates its find and replace columns; refill it'

export interface MatrixLayer { layer: string, tests: string[], mutations: MatrixMutation[] }

export interface Matrix {
  full: string | null
  layers: MatrixLayer[]
  skipped: { mutation: MatrixMutation, why: SkipReason }[]
}

export type MutationOutcome = 'killed' | 'survived' | 'not-run'

export type NotRunReason
  = | 'it is not a find and replace line with a predicted test'
    | 'its file or its test is outside the tree'
    | 'its test file does not exist'
    | 'the find text does not occur exactly once'
    | 'its test is red on the unmutated file'
    | 'its test did not run'
    | 'the run was interrupted'

export interface MatrixResult { mutation: MatrixMutation, outcome: MutationOutcome, why: NotRunReason | null }

export type TestRun = 'passed' | 'failed' | 'error' | 'interrupted'

export type RunTest = (root: string, test: string, signal: AbortSignal) => TestRun | Promise<TestRun>

interface TestRow { test: string, layer: string }

interface MutationRow { card: number, id: string, operator: string, file: string, layer: string, find: string | null, replacement: string | null, killed_by: string | null }

function skipReason(mutation: MatrixMutation, layers: readonly string[], findRecorded: boolean): SkipReason | null {
  if (!layers.includes(mutation.layer))
    return 'its layer is not touched'
  if (mutation.killedBy === null)
    return 'no test predicted to kill it'
  if (!findRecorded)
    return 'the catalog predates its find and replace columns; refill it'
  return mutation.find === null ? 'not a find and replace line' : null
}

export function buildMatrix(changed: readonly string[], graph: Graph, testText: (test: string) => string, db: DatabaseSync): Matrix {
  const run = selectRun(changed, graph, testText)
  if (run.kind === 'full')
    return { full: run.why, layers: [], skipped: [] }
  const catalogTests = db.prepare('SELECT test, layer FROM check_tests').all() as unknown as TestRow[]
  const missing = missingMutationColumns(db)
  const column = (name: string) => (missing.includes(name) ? `NULL AS ${name}` : name)
  const mutations: MatrixMutation[] = (db.prepare(`SELECT card, id, operator, file, layer, ${column('find')}, ${column('replacement')}, killed_by FROM check_mutations ORDER BY card, id`).all() as unknown as MutationRow[])
    .map(row => ({ card: row.card, id: row.id, operator: row.operator, file: row.file, layer: row.layer, find: row.find, replacement: row.replacement, killedBy: row.killed_by }))
  const skipped = mutations.flatMap((mutation) => {
    const why = skipReason(mutation, run.layers, missing.length === 0)
    return why === null ? [] : [{ mutation, why }]
  })
  const kept = mutations.filter(mutation => !skipped.some(entry => entry.mutation === mutation))
  const layers = run.layers.map(layer => ({
    layer,
    tests: catalogTests.filter(row => row.layer.split(',').includes(layer) && run.tests.includes(row.test)).map(row => row.test).sort(),
    mutations: kept.filter(mutation => mutation.layer === layer),
  }))
  return { full: null, layers, skipped }
}

export function vitestRun(root: string, test: string, signal: AbortSignal): Promise<TestRun> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['--dir', root, 'exec', 'vitest', 'run', test], { stdio: 'ignore', signal })
    child.once('error', () => resolve(signal.aborted ? 'interrupted' : 'error'))
    child.once('close', (status, killedBy) => {
      if (killedBy !== null || signal.aborted)
        resolve('interrupted')
      else
        resolve(status === 0 ? 'passed' : 'failed')
    })
  })
}

export class MutationGuard {
  #pending: { target: string, original: string } | null = null
  readonly #abort = new AbortController()

  get signal(): AbortSignal {
    return this.#abort.signal
  }

  apply(target: string, original: string, mutated: string): void {
    this.#pending = { target, original }
    writeFileSync(target, mutated)
  }

  restore(): void {
    if (this.#pending !== null)
      writeFileSync(this.#pending.target, this.#pending.original)
    this.#pending = null
  }

  abandon(): void {
    this.#abort.abort()
    this.restore()
  }
}

function insideTree(root: string, file: string): string | null {
  const target = path.resolve(root, file)
  const relative = path.relative(root, target)
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? null : target
}

function notRun(mutation: MatrixMutation, why: NotRunReason): MatrixResult {
  return { mutation, outcome: 'not-run', why }
}

function resultOf(mutation: MatrixMutation, mutated: TestRun): MatrixResult {
  if (mutated === 'interrupted')
    return notRun(mutation, 'the run was interrupted')
  if (mutated === 'error')
    return notRun(mutation, 'its test did not run')
  return { mutation, outcome: mutated === 'failed' ? 'killed' : 'survived', why: null }
}

export function holdSignalsUntilRestored(guard: MutationGuard): void {
  for (const signal of HELD_SIGNALS) {
    process.once(signal, () => {
      guard.abandon()
      process.exit(128 + os.constants.signals[signal])
    })
  }
}

export async function runMutation(root: string, mutation: MatrixMutation, runTest: RunTest = vitestRun, guard = new MutationGuard()): Promise<MatrixResult> {
  const { find, replacement, killedBy } = mutation
  if (find === null || replacement === null || killedBy === null)
    return notRun(mutation, 'it is not a find and replace line with a predicted test')
  const target = insideTree(root, mutation.file)
  const test = insideTree(root, killedBy)
  if (target === null || test === null)
    return notRun(mutation, 'its file or its test is outside the tree')
  if (!existsSync(test))
    return notRun(mutation, 'its test file does not exist')
  const original = readFileSync(target, 'utf8')
  if (original.split(find).length !== 2)
    return notRun(mutation, 'the find text does not occur exactly once')
  const base = await runTest(root, killedBy, guard.signal)
  if (base === 'interrupted')
    return notRun(mutation, 'the run was interrupted')
  if (base !== 'passed')
    return notRun(mutation, base === 'failed' ? 'its test is red on the unmutated file' : 'its test did not run')
  guard.apply(target, original, original.replace(find, () => replacement))
  try {
    return resultOf(mutation, await runTest(root, killedBy, guard.signal))
  }
  finally {
    guard.restore()
  }
}

export async function runMatrix(matrix: Matrix, root: string, runTest: RunTest = vitestRun, guard = new MutationGuard()): Promise<MatrixResult[]> {
  const results: MatrixResult[] = []
  for (const mutation of matrix.layers.flatMap(layer => layer.mutations)) {
    const interrupted = results.some(result => result.why === 'the run was interrupted')
    results.push(interrupted ? notRun(mutation, 'the run was interrupted') : await runMutation(root, mutation, runTest, guard))
  }
  return results
}

export function matrixSummary(matrix: Matrix, results: readonly MatrixResult[]): string {
  if (matrix.full !== null)
    return `Matrix: not built, full run: ${matrix.full}.`
  const lines = matrix.layers.map((layer) => {
    const outcomes = layer.mutations.map((mutation) => {
      const result = results.find(entry => entry.mutation === mutation)
      const why = result?.why ?? null
      return `${result?.outcome ?? 'not-run'} #${mutation.card}/${mutation.id}${why === null ? '' : ` (${why})`}`
    })
    return `Layer ${layer.layer}: ${layer.tests.length} tests; mutations: ${outcomes.join(', ') || 'none'}.`
  })
  const skipped = matrix.skipped.map(entry => `Skipped #${entry.mutation.card}/${entry.mutation.id}: ${entry.why}.`)
  return [...lines, ...skipped].join('\n')
}

async function main(): Promise<void> {
  const changed = process.argv.slice(2)
  const db = openDatabase(defaultBusPath(), { readOnly: true })
  const matrix = buildMatrix(changed, cruise(), test => readFileSync(path.join(REPO_ROOT, test), 'utf8'), db)
  db.close()
  const guard = new MutationGuard()
  holdSignalsUntilRestored(guard)
  const summary = matrixSummary(matrix, await runMatrix(matrix, REPO_ROOT, vitestRun, guard))
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
}

if (process.argv[1] === import.meta.filename)
  await main()

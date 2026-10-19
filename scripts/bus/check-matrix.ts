import type { DatabaseSync } from 'node:sqlite'
import type { Graph } from '../ci/layers.js'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { selectRun } from '../ci/layers.js'
import { cruise } from '../ci/select.js'
import { defaultBusPath } from './db.js'
import { openDatabase } from './sqlite.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const OPERATOR_ARROW = ' → '

export interface MatrixMutation { card: number, id: string, file: string, layer: string, operator: string, killedBy: string | null }

export type SkipReason = 'no test predicted to kill it' | 'not a find and replace line' | 'its layer is not touched'

export interface MatrixLayer { layer: string, tests: string[], mutations: MatrixMutation[] }

export interface Matrix {
  full: string | null
  layers: MatrixLayer[]
  skipped: { mutation: MatrixMutation, why: SkipReason }[]
}

export type MutationOutcome = 'killed' | 'survived' | 'not-run'

export interface MatrixResult { mutation: MatrixMutation, outcome: MutationOutcome }

export type RunTest = (root: string, test: string) => boolean

interface TestRow { test: string, layer: string }

interface MutationRow { card: number, id: string, operator: string, file: string, layer: string, killed_by: string | null }

function isFindLine(mutation: MatrixMutation): boolean {
  return mutation.operator.includes(OPERATOR_ARROW)
}

function skipReason(mutation: MatrixMutation, layers: readonly string[]): SkipReason | null {
  if (!layers.includes(mutation.layer))
    return 'its layer is not touched'
  if (mutation.killedBy === null)
    return 'no test predicted to kill it'
  return isFindLine(mutation) ? null : 'not a find and replace line'
}

export function buildMatrix(changed: readonly string[], graph: Graph, testText: (test: string) => string, db: DatabaseSync): Matrix {
  const run = selectRun(changed, graph, testText)
  if (run.kind === 'full')
    return { full: run.why, layers: [], skipped: [] }
  const catalogTests = db.prepare('SELECT test, layer FROM check_tests').all() as unknown as TestRow[]
  const mutations: MatrixMutation[] = (db.prepare('SELECT card, id, operator, file, layer, killed_by FROM check_mutations ORDER BY card, id').all() as unknown as MutationRow[])
    .map(row => ({ card: row.card, id: row.id, operator: row.operator, file: row.file, layer: row.layer, killedBy: row.killed_by }))
  const skipped = mutations.flatMap((mutation) => {
    const why = skipReason(mutation, run.layers)
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

export function vitestKills(root: string, test: string): boolean {
  const run = spawnSync('pnpm', ['--dir', root, 'exec', 'vitest', 'run', test], { encoding: 'utf8' })
  return run.status !== 0
}

export function runMutation(root: string, mutation: MatrixMutation, runTest: RunTest = vitestKills): MatrixResult {
  const target = path.resolve(root, mutation.file)
  const original = readFileSync(target, 'utf8')
  const at = mutation.operator.indexOf(OPERATOR_ARROW)
  const find = mutation.operator.slice(0, at)
  const replace = mutation.operator.slice(at + OPERATOR_ARROW.length)
  if (mutation.killedBy === null || at === -1 || original.split(find).length !== 2)
    return { mutation, outcome: 'not-run' }
  writeFileSync(target, original.replace(find, () => replace))
  try {
    return { mutation, outcome: runTest(root, mutation.killedBy) ? 'killed' : 'survived' }
  }
  finally {
    writeFileSync(target, original)
  }
}

export function runMatrix(matrix: Matrix, root: string, runTest: RunTest = vitestKills): MatrixResult[] {
  return matrix.layers.flatMap(layer => layer.mutations.map(mutation => runMutation(root, mutation, runTest)))
}

export function matrixSummary(matrix: Matrix, results: readonly MatrixResult[]): string {
  if (matrix.full !== null)
    return `Matrix: not built, full run: ${matrix.full}.`
  const lines = matrix.layers.map((layer) => {
    const outcomes = layer.mutations.map((mutation) => {
      const outcome = results.find(result => result.mutation === mutation)?.outcome ?? 'not-run'
      return `${outcome} #${mutation.card}/${mutation.id}`
    })
    return `Layer ${layer.layer}: ${layer.tests.length} tests; mutations: ${outcomes.join(', ') || 'none'}.`
  })
  const skipped = matrix.skipped.map(entry => `Skipped #${entry.mutation.card}/${entry.mutation.id}: ${entry.why}.`)
  return [...lines, ...skipped].join('\n')
}

function main(): void {
  const changed = process.argv.slice(2)
  const db = openDatabase(defaultBusPath(), { readOnly: true })
  const matrix = buildMatrix(changed, cruise(), test => readFileSync(path.join(REPO_ROOT, test), 'utf8'), db)
  db.close()
  const summary = matrixSummary(matrix, runMatrix(matrix, REPO_ROOT))
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
}

if (process.argv[1] === import.meta.filename)
  main()

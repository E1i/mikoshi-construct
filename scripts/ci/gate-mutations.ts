import type { Matrix, MatrixMutation, MatrixResult, RunTest } from '../cli/check-matrix.js'
import type { Graph } from './layers.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { buildMatrix, holdSignalsUntilRestored, MutationGuard, runMatrix, vitestRun } from '../cli/check-matrix.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../core/db.js'
import { openDatabase } from '../core/sqlite.js'

export const MUTATION_CEILING_MS = 120_000
export const UNCHECKED = 'mutations unchecked'
export const SURVIVED_HEADER = 'prepush: red — a predicted witness mutation survived on a touched file; the push does not happen. Make a witness kill it in this session and run the gate again:'

export interface MutationGate { lines: string[], code: number }

export interface MutationGateParts {
  matrix: () => Matrix
  witnesses: readonly string[]
  changed: readonly string[]
  root: string
  runTest?: RunTest
  ceilingMs?: number
  guard?: MutationGuard
}

const INTERRUPTED = 'the run was interrupted'

export function witnessMutations(matrix: Matrix, witnesses: readonly string[], changed: readonly string[]): Matrix {
  const named = new Set(witnesses)
  const touched = new Set(changed)
  const kept = (mutation: MatrixMutation) => mutation.killedBy !== null && named.has(mutation.killedBy) && touched.has(mutation.file)
  return { full: matrix.full, layers: matrix.layers.map(layer => ({ ...layer, mutations: layer.mutations.filter(kept) })).filter(layer => layer.mutations.length > 0), skipped: [] }
}

function lineOf(root: string, mutation: MatrixMutation): number | null {
  const target = path.join(root, mutation.file)
  if (mutation.find === null || !existsSync(target))
    return null
  const text = readFileSync(target, 'utf8')
  const at = text.indexOf(mutation.find)
  return at === -1 ? null : text.slice(0, at).split('\n').length
}

export function survivorLine(root: string, mutation: MatrixMutation): string {
  const line = lineOf(root, mutation)
  return `survived: ${mutation.file}:${line ?? '?'} ${mutation.operator}`
}

function unchecked(reason: string): MutationGate {
  return { lines: [`${UNCHECKED}: ${reason}`], code: 0 }
}

async function underTheCeiling(matrix: Matrix, parts: MutationGateParts): Promise<MatrixResult[]> {
  const guard = parts.guard ?? new MutationGuard()
  const timer = setTimeout(() => guard.abandon(), parts.ceilingMs ?? MUTATION_CEILING_MS)
  try {
    return await runMatrix(matrix, parts.root, parts.runTest ?? vitestRun, guard)
  }
  finally {
    clearTimeout(timer)
  }
}

export async function mutationGate(parts: MutationGateParts): Promise<MutationGate> {
  if (parts.witnesses.length === 0)
    return { lines: [], code: 0 }
  let built: Matrix
  try {
    built = parts.matrix()
  }
  catch (error) {
    return unchecked(`the check catalog could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (built.full !== null)
    return unchecked(`the change reaches a full run (${built.full}), which has no layered mutations`)
  const matrix = witnessMutations(built, parts.witnesses, parts.changed)
  const mutations = matrix.layers.flatMap(layer => layer.mutations)
  if (mutations.length === 0)
    return { lines: [], code: 0 }
  const results = await underTheCeiling(matrix, parts)
  const survivors = results.filter(result => result.outcome === 'survived').map(result => survivorLine(parts.root, result.mutation))
  const ceiling = results.some(result => result.why === INTERRUPTED)
    ? [`${UNCHECKED}: the ${mutations.length} predicted witness mutations did not fit under ${Math.round((parts.ceilingMs ?? MUTATION_CEILING_MS) / 1000)} s; review checks them`]
    : []
  if (survivors.length > 0)
    return { lines: [SURVIVED_HEADER, ...survivors, ...ceiling], code: 1 }
  return { lines: ceiling, code: 0 }
}

export function busMatrix(changed: readonly string[], graph: Graph, testText: (test: string) => string, busPath: string = defaultBusPath()): Matrix {
  if (!existsSync(busPath))
    throw new Error(`no bus at ${busPath}`)
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    return buildMatrix(changed, graph, testText, db)
  }
  finally {
    db.close()
  }
}

export async function processMutationGate(changed: readonly string[], graph: Graph, witnesses: readonly string[], testText: (test: string) => string, root: string): Promise<MutationGate> {
  const guard = new MutationGuard()
  holdSignalsUntilRestored(guard)
  return mutationGate({ matrix: () => busMatrix(changed, graph, testText), witnesses, changed, root, guard })
}

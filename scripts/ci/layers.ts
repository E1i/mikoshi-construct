import path from 'node:path'

export const BUS_CORE = /^scripts\/bus\/(?:db|reducer|sqlite|stored|identifiers)\.ts$/
export const BUS_SERVICE = /^scripts\/bus\/([a-z]+)-(?:worker|executor|starter)\.ts$/
const TEST_FILE = /\.test\.ts$/
const TEST_ROOTS = ['tests/', 'scripts/tests/']
const SCRIPT_DIR = /^scripts\/([^/]+)\//
const SOURCE_FILE = /\.ts$/

export type Graph = ReadonlyMap<string, readonly string[]>

export type Run
  = | { kind: 'full', why: string }
    | { kind: 'layers', layers: string[], tests: string[] }

export interface CatalogMutation {
  id: string
  file: string
  killedBy: string
}

export interface MatrixRow {
  id: string
  layer: string
  killedBy: string
  runs: boolean
}

export function isTest(file: string): boolean {
  return TEST_FILE.test(file) && TEST_ROOTS.some(root => file.startsWith(root))
}

export function layerOf(file: string): string | null {
  if (TEST_ROOTS.some(root => file.startsWith(root)) || !SOURCE_FILE.test(file))
    return null
  if (BUS_CORE.test(file))
    return 'bus-core'
  const service = BUS_SERVICE.exec(file)?.[1]
  if (service !== undefined)
    return `bus:${service}`
  if (file.startsWith('src/'))
    return 'src'
  const dir = SCRIPT_DIR.exec(file)?.[1]
  return dir === undefined ? null : dir
}

export function reverseGraph(graph: Graph): Map<string, string[]> {
  const reverse = new Map<string, string[]>()
  for (const [from, targets] of graph) {
    for (const to of targets)
      reverse.set(to, [...(reverse.get(to) ?? []), from])
  }
  return reverse
}

function dependents(changed: readonly string[], reverse: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set(changed)
  const queue = [...changed]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const from of reverse.get(file) ?? []) {
      if (!seen.has(from)) {
        seen.add(from)
        queue.push(from)
      }
    }
  }
  return seen
}

function spawnedBy(file: string, tests: readonly string[], testText: (test: string) => string): string[] {
  const named = [file, path.basename(file)]
  return tests.filter(test => named.some(name => testText(test).includes(name)))
}

export function selectRun(changed: readonly string[], graph: Graph, testText: (test: string) => string): Run {
  if (changed.length === 0)
    return { kind: 'full', why: 'no changed path was given' }
  const unmapped = changed.find(file => !isTest(file) && (layerOf(file) === null || !graph.has(file)))
  if (unmapped !== undefined)
    return { kind: 'full', why: `${unmapped} belongs to no layer of the dependency graph` }
  const allTests = [...graph.keys()].filter(isTest)
  const reverse = reverseGraph(graph)
  const reached = dependents(changed, reverse)
  const spawning = changed.flatMap(file => spawnedBy(file, allTests, testText))
  const closure = dependents([...reached, ...spawning], reverse)
  const layers = [...new Set([...closure].map(layerOf).filter(layer => layer !== null))].sort()
  const tests = [...closure].filter(isTest).sort()
  return { kind: 'layers', layers, tests }
}

export function mutationMatrix(run: Run, mutations: readonly CatalogMutation[]): MatrixRow[] {
  return mutations.flatMap((mutation) => {
    const layer = layerOf(mutation.file)
    if (layer === null || (run.kind === 'layers' && !run.layers.includes(layer)))
      return []
    return [{ id: mutation.id, layer, killedBy: mutation.killedBy, runs: run.kind === 'full' || run.tests.includes(mutation.killedBy) }]
  })
}

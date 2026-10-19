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

export const SCANNED_TREES: Readonly<Record<string, readonly string[]>> = {
  'src/': ['tests/dependency-policy.test.ts', 'tests/graph-command.test.ts', 'tests/every-source-has-a-reader.test.ts', 'tests/intake-command-word.test.ts', 'tests/delivery-boundary.test.ts'],
  'scripts/': ['tests/graph-command.test.ts', 'scripts/tests/bus/sqlite.test.ts'],
  'scripts/bus/': ['scripts/tests/ci/layers.test.ts'],
  'scripts/ghosts/': ['scripts/tests/shredder/owner-merges.test.ts'],
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

function spawnedBy(files: Iterable<string>, readers: readonly string[], testText: (test: string) => string): string[] {
  const named = [...files].flatMap(file => [file, path.basename(file)])
  return readers.filter(reader => named.some(name => testText(reader).includes(name)))
}

function scanning(file: string, tests: readonly string[]): string[] {
  return Object.entries(SCANNED_TREES)
    .filter(([root]) => file.startsWith(root))
    .flatMap(([, scanners]) => scanners.filter(test => tests.includes(test)))
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
  const readers = [...graph.keys()].filter(file => TEST_ROOTS.some(root => file.startsWith(root)))
  const spawning = [...spawnedBy(reached, readers, testText), ...changed.flatMap(file => scanning(file, allTests))]
  const closure = dependents([...reached, ...spawning], reverse)
  const layers = [...new Set([...closure].map(layerOf).filter(layer => layer !== null))].sort()
  const tests = [...closure].filter(isTest).sort()
  return { kind: 'layers', layers, tests }
}

import type { LayerMap } from '../core/layer-map.js'
import path from 'node:path'
import { isTest, NAMED_READERS, PACKAGE_MANIFEST, PACKAGE_SCRIPT_READERS, SCANNED_TREES, TEST_ROOTS } from '../../src/card/covering-tests.js'
import { FACTORY_FOLDERS, FACTORY_NAMED } from '../core/factory-paths.js'
import { layersIn, readLayerMap } from '../core/layer-map.js'
import { scansATree } from './tree-scanners.js'

export { isTest }

export const BUS_CORE = /^scripts\/core\/(?:db|reducer|sqlite|stored|identifiers)\.ts$/
export const BUS_SERVICE = /^scripts\/(?:nodes\/[a-z]+|ladder)\/([a-z]+)-(?:worker|executor|starter)\.ts$/
export const BUS_SHARED: readonly string[] = [
  FACTORY_NAMED.busDatabase,
  FACTORY_NAMED.busErrors,
  FACTORY_NAMED.busLease,
  FACTORY_NAMED.busNode,
  FACTORY_NAMED.busQueue,
  FACTORY_NAMED.busStamping,
  FACTORY_NAMED.busStored,
]
export const BUS_TESTS = `${FACTORY_FOLDERS.busTests[0]}/`
const LAYERS = readLayerMap()
const SCRIPT_DIR = /^scripts\/([^/]+)\//
const SOURCE_FILE = /\.ts$/
const CHANGESET_NOTE = /^\.changeset\/[^/]+\.md$/
const TEST_INFRASTRUCTURE = /^(?:vitest\.config\.ts|vitest-[^/]+\.ts|scripts\/scratch\/vitest-[^/]+|scripts\/ci\/.+)$/

export type Graph = ReadonlyMap<string, readonly string[]>

export type Run
  = | { kind: 'full', why: string }
    | { kind: 'layers', layers: string[], tests: string[] }

function underTestRoot(file: string): boolean {
  return TEST_ROOTS.some(root => file.startsWith(`${root}/`))
}

export function layerIn(map: LayerMap, file: string): string | null {
  if (underTestRoot(file) || !SOURCE_FILE.test(file))
    return null
  const layers = layersIn(map, file)
  if (layers.length === 0)
    return SCRIPT_DIR.exec(file)?.[1] ?? null
  return layers.length === 1 ? layers[0]! : null
}

export function layerOf(file: string): string | null {
  return layerIn(LAYERS, file)
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

export function selectRun(given: readonly string[], graph: Graph, testText: (test: string) => string): Run {
  if (given.length === 0)
    return { kind: 'full', why: 'no changed path was given' }
  const changed = given.filter(file => !CHANGESET_NOTE.test(file))
  if (changed.length === 0)
    return { kind: 'layers', layers: [], tests: [] }
  const infrastructure = changed.find(file => TEST_INFRASTRUCTURE.test(file))
  if (infrastructure !== undefined)
    return { kind: 'full', why: `${infrastructure} is test infrastructure every test runs under` }
  const unmapped = changed.find(file => !isTest(file) && (layerOf(file) === null || !graph.has(file)))
  if (unmapped !== undefined)
    return { kind: 'full', why: `${unmapped} belongs to no layer of the dependency graph` }
  const allTests = [...graph.keys()].filter(isTest)
  const reverse = reverseGraph(graph)
  const reached = dependents(changed, reverse)
  const readers = [...graph.keys()].filter(underTestRoot)
  const treeScanners = allTests.filter(test => scansATree(testText(test)))
  const busWide = changed.some(file => BUS_SHARED.includes(file)) ? allTests.filter(test => test.startsWith(BUS_TESTS)) : []
  const named = changed.flatMap(file => NAMED_READERS[file] ?? []).filter(test => graph.has(test))
  const spawning = [...spawnedBy(reached, readers, testText), ...changed.flatMap(file => scanning(file, allTests)), ...treeScanners, ...busWide, ...named]
  const closure = dependents([...reached, ...spawning], reverse)
  const layers = [...new Set([...closure].map(layerOf).filter(layer => layer !== null))].sort()
  const tests = [...closure].filter(isTest).sort()
  return { kind: 'layers', layers, tests }
}

export function windowGate(changed: readonly string[], graph: Graph, testText: (test: string) => string): Run {
  if (!changed.includes(PACKAGE_MANIFEST))
    return selectRun(changed, graph, testText)
  const rest = changed.filter(file => file !== PACKAGE_MANIFEST)
  const run: Run = rest.length === 0 ? { kind: 'layers', layers: [], tests: [] } : selectRun(rest, graph, testText)
  if (run.kind === 'full')
    return run
  const readers = PACKAGE_SCRIPT_READERS.filter(test => graph.has(test))
  return { kind: 'layers', layers: run.layers, tests: [...new Set([...run.tests, ...readers])].sort() }
}

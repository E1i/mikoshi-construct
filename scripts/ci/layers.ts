import type { LayerMap } from '../core/layer-map.js'
import path from 'node:path'
import { isTest, NAMED_READERS, PACKAGE_MANIFEST, PACKAGE_SCRIPT_READERS, SCANNED_TREES, TEST_ROOTS } from '../../src/card/covering-tests.js'
import { FACTORY_FOLDERS, FACTORY_NAMED } from '../core/factory-paths.js'
import { declaredLayersIn, isCheckPipeline, isDocument, isRecord, layersInOf, repositoryLayerMap } from '../core/layer-map.js'
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
const CHANGESET_NOTE = /^\.changeset\/[^/]+\.md$/
const CHANGESET_TOUCH = '.changeset/**'
const CONTRACT_RECORD_TESTS = 'tests/contract/'
export const CHANGESET_READERS: readonly string[] = ['tests/changesets-one-line.test.ts']

export type Graph = ReadonlyMap<string, readonly string[]>

export type Run
  = | { kind: 'full', why: string }
    | { kind: 'layers', layers: string[], tests: string[] }

function underTestRoot(file: string): boolean {
  return TEST_ROOTS.some(root => file.startsWith(`${root}/`))
}

export function isChangesetNote(entry: string): boolean {
  return entry === CHANGESET_TOUCH || CHANGESET_NOTE.test(entry)
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

function modulesOfLayers(layers: readonly string[], graph: Graph, map: LayerMap): string[] {
  return [...graph.keys()].filter(file => !isTest(file) && layersInOf(map, file).some(layer => layers.includes(layer)))
}

const TOO_WIDE_TO_NAME = new Set(['scripts', ...TEST_ROOTS])
const NAME_CHARACTER = /[\w-]/
const READABLE_MODULE = /^(?!node_modules\/)[\w.-]+(?:\/[\w.-]+)*\.[cm]?[jt]s$/

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function namesOf(file: string): string[] {
  const segments = file.split('/')
  const directories = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'))
  return [...new Set([file, segments.at(-1)!, ...directories, ...segments.slice(0, -1)])].filter(name => !TOO_WIDE_TO_NAME.has(name))
}

function names(text: string, name: string): boolean {
  if (!text.includes(name))
    return false
  const edge = NAME_CHARACTER.test(name.at(-1)!) ? '(?![\\w])' : ''
  return new RegExp(`(?<![\\w-])${escaped(name)}${edge}`).test(text)
}

export function pathReaders(file: string, graph: Graph, moduleText: (module: string) => string): string[] {
  const named = namesOf(file)
  return [...graph.keys()].filter(module => module !== file && READABLE_MODULE.test(module) && named.some(name => names(moduleText(module), name)))
}

function resolvedByLayers(file: string, graph: Graph, map: LayerMap): boolean {
  if (isDocument(file))
    return true
  if (underTestRoot(file) && graph.has(file))
    return true
  const layers = layersInOf(map, file)
  if (layers.length === 0)
    return false
  return graph.has(file) || isRecord(map, file) || (declaredLayersIn(map, file).length > 0 && modulesOfLayers(layers, graph, map).length > 0)
}

function seedsOfLayers(file: string, graph: Graph, map: LayerMap): string[] {
  if (isRecord(map, file))
    return []
  const layers = layersInOf(map, file)
  return !isTest(file) && (!graph.has(file) || layers.length > 1) ? modulesOfLayers(layers, graph, map) : []
}

export function selectRun(given: readonly string[], graph: Graph, testText: (test: string) => string, map: LayerMap = repositoryLayerMap()): Run {
  if (given.length === 0)
    return { kind: 'full', why: 'no changed path was given' }
  const changed = given.filter(file => !CHANGESET_NOTE.test(file))
  const changesetReaders = changed.length < given.length ? CHANGESET_READERS.filter(test => graph.has(test)) : []
  if (changed.length === 0)
    return { kind: 'layers', layers: [], tests: [...changesetReaders] }
  const infrastructure = changed.find(isCheckPipeline)
  if (infrastructure !== undefined)
    return { kind: 'full', why: `${infrastructure} is test infrastructure every test runs under` }
  const texts = new Map<string, string>()
  const moduleText = (module: string): string => texts.get(module) ?? texts.set(module, testText(module)).get(module)!
  const readByPath = new Map(changed.filter(file => !isTest(file) && !graph.has(file) && !isDocument(file)).map(file => [file, pathReaders(file, graph, moduleText)]))
  const unmapped = changed.find(file => !isTest(file) && !resolvedByLayers(file, graph, map) && (readByPath.get(file) ?? []).length === 0)
  if (unmapped !== undefined)
    return { kind: 'full', why: `${unmapped} belongs to no layer of the dependency graph` }
  const allTests = [...graph.keys()].filter(isTest)
  const reverse = reverseGraph(graph)
  const reached = dependents([...changed, ...changed.flatMap(file => seedsOfLayers(file, graph, map))], reverse)
  const readers = [...graph.keys()].filter(underTestRoot)
  const treeScanners = allTests.filter(test => scansATree(moduleText(test)))
  const busWide = changed.some(file => BUS_SHARED.includes(file)) ? allTests.filter(test => test.startsWith(BUS_TESTS)) : []
  const named = changed.flatMap(file => NAMED_READERS[file] ?? []).filter(test => graph.has(test))
  const recordReaders = changed.some(file => isRecord(map, file)) ? allTests.filter(test => test.startsWith(CONTRACT_RECORD_TESTS)) : []
  const spawning = [...[...readByPath.values()].flat(), ...spawnedBy(reached, readers, moduleText), ...changed.flatMap(file => scanning(file, allTests)), ...treeScanners, ...busWide, ...named, ...recordReaders, ...changesetReaders]
  const closure = dependents([...reached, ...spawning], reverse)
  const layers = [...new Set([...closure].flatMap(file => layersInOf(map, file)))].sort()
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

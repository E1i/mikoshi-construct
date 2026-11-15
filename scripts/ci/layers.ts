import type { LayerMap } from '../core/layer-map.js'
import path from 'node:path'
import { DECLARED_PATH_READERS, EVERY_CHANGE_READERS, NAMED_READERS, PACKAGE_MANIFEST, PACKAGE_SCRIPT_READERS, SCANNED_TREES } from '../../src/card/covering-tests.js'
import { BUS_CORE, BUS_SERVICE, FACTORY_FOLDERS, FACTORY_LISTS, GENERATED_FILES, RATCHET_FILE } from '../core/factory-paths.js'
import { declaredLayersIn, globalRunReason, isCheckPipeline, isDocument, isRecord, layersInOf, repositoryLayerMap } from '../core/layer-map.js'
import { isTest, TEST_ROOTS } from '../policy/touch-scope.js'
import { scansATree } from './tree-scanners.js'

export { BUS_CORE, BUS_SERVICE, isTest }

export const BUS_SHARED: readonly string[] = FACTORY_LISTS.busShared
export const BUS_TESTS = `${FACTORY_FOLDERS.busTests[0]}/`
const CHANGESET_NOTE = /^\.changeset\/[^/]+\.md$/
const CHANGESET_TOUCH = '.changeset/**'
const CONTRACT_RECORD_TESTS = 'tests/contract/'
export const CHANGESET_READERS: readonly string[] = FACTORY_LISTS.changesetReaders

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

export function declaredReadersOf(file: string): readonly string[] | undefined {
  return Object.entries(DECLARED_PATH_READERS).find(([place]) => place.endsWith('/') ? file.startsWith(place) : file === place)?.[1]
}

export function pathReaders(file: string, graph: Graph, moduleText: (module: string) => string): string[] {
  const declared = declaredReadersOf(file)
  if (declared !== undefined)
    return [...declared.filter(module => graph.has(module)), ...[...graph.keys()].filter(module => isTest(module) && names(moduleText(module), file))]
  const named = namesOf(file)
  return [...graph.keys()].filter(module => module !== file && READABLE_MODULE.test(module) && named.some(name => names(moduleText(module), name)))
}

function isImported(file: string, graph: Graph): boolean {
  return [...graph.values()].some(targets => targets.includes(file))
}

function resolvedByLayers(file: string, graph: Graph, map: LayerMap): boolean {
  if (isDocument(file))
    return true
  if (underTestRoot(file) && graph.has(file))
    return isImported(file, graph)
  const layers = layersInOf(map, file)
  if (layers.length === 0)
    return false
  return graph.has(file) || isRecord(map, file) || (declaredLayersIn(map, file).length > 0 && modulesOfLayers(layers, graph, map).length > 0)
}

export function fullRunReason(changed: readonly string[], graph: Graph, moduleText: (module: string) => string, map: LayerMap): string | null {
  const infrastructure = changed.find(isCheckPipeline)
  if (infrastructure !== undefined)
    return `${infrastructure} is test infrastructure every test runs under`
  const global = changed.map(file => globalRunReason(map, file)).find((reason): reason is string => reason !== null)
  if (global !== undefined)
    return global
  const unmapped = changed.find(file => !isTest(file) && !resolvedByLayers(file, graph, map) && pathReaders(file, graph, moduleText).length === 0)
  return unmapped === undefined ? null : `${unmapped} belongs to no layer of the dependency graph`
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
    return { kind: 'layers', layers: [], tests: [...new Set([...changesetReaders, ...EVERY_CHANGE_READERS.filter(test => graph.has(test))])].sort() }
  const texts = new Map<string, string>()
  const moduleText = (module: string): string => texts.get(module) ?? texts.set(module, testText(module)).get(module)!
  const why = fullRunReason(changed, graph, moduleText, map)
  if (why !== null)
    return { kind: 'full', why }
  const readByPath = new Map(changed.filter(file => !isTest(file) && !isDocument(file) && (!graph.has(file) || !resolvedByLayers(file, graph, map))).map(file => [file, pathReaders(file, graph, moduleText)]))
  const allTests = [...graph.keys()].filter(isTest)
  const reverse = reverseGraph(graph)
  const reached = dependents([...changed, ...changed.flatMap(file => seedsOfLayers(file, graph, map))], reverse)
  const readers = [...graph.keys()].filter(underTestRoot)
  const treeScanners = allTests.filter(test => scansATree(moduleText(test)) || EVERY_CHANGE_READERS.includes(test))
  const busWide = changed.some(file => BUS_SHARED.includes(file)) ? allTests.filter(test => test.startsWith(BUS_TESTS)) : []
  const named = changed.flatMap(file => NAMED_READERS[file] ?? []).filter(test => graph.has(test))
  const recordReaders = changed.some(file => isRecord(map, file)) ? allTests.filter(test => test.startsWith(CONTRACT_RECORD_TESTS)) : []
  const spawning = [...[...readByPath.values()].flat(), ...spawnedBy(reached, readers, moduleText), ...changed.flatMap(file => scanning(file, allTests)), ...treeScanners, ...busWide, ...named, ...recordReaders, ...changesetReaders]
  const closure = dependents([...reached, ...spawning], reverse)
  const layers = [...new Set([...closure].flatMap(file => layersInOf(map, file)))].sort()
  const tests = [...closure].filter(isTest).sort()
  return { kind: 'layers', layers, tests }
}

export type LayeredRun = Extract<Run, { kind: 'layers' }>

export interface SessionRun {
  run: LayeredRun
  why: string
}

const SCRIPT_MODULE = /^(?:scripts|src)\/[\w./-]+\.ts$/
const WHITESPACE = /\s+/

function scriptModules(command: string): string[] {
  return command.split(WHITESPACE).filter(token => SCRIPT_MODULE.test(token))
}

export function packageScriptsOf(manifest: () => string): Readonly<Record<string, string>> {
  try {
    const scripts = (JSON.parse(manifest()) as { scripts?: unknown }).scripts
    return typeof scripts === 'object' && scripts !== null ? scripts as Record<string, string> : {}
  }
  catch {
    return {}
  }
}

export const MODULE_FILES = GENERATED_FILES.moduleFiles.path

const GENERATOR_ROWS: readonly { path: string, rebuild: readonly string[] | null }[] = [...Object.values(GENERATED_FILES), RATCHET_FILE]

export function generatorModules(file: string, packageScripts: Readonly<Record<string, string>>): string[] {
  const rebuilds = GENERATOR_ROWS.flatMap(row => row.path === file && row.rebuild !== null ? [row.rebuild] : [])
  return [...new Set(rebuilds.flatMap((rebuild) => {
    const script = packageScripts[rebuild[0] ?? '']
    return [...rebuild.flatMap(scriptModules), ...(typeof script === 'string' ? scriptModules(script) : [])]
  }))].sort()
}

function readersByName(file: string, graph: Graph, moduleText: (module: string) => string): string[] {
  const own = [...new Set([file, path.basename(file)])]
  return [...graph.keys()].filter(module => module !== file && READABLE_MODULE.test(module) && own.some(name => names(moduleText(module), name)))
}

export function coveringTests(file: string, graph: Graph, moduleText: (module: string) => string, packageScripts: Readonly<Record<string, string>>): string[] {
  const readers = [...(declaredReadersOf(file) ?? []), ...readersByName(file, graph, moduleText), ...generatorModules(file, packageScripts)].filter(module => graph.has(module))
  return [...dependents([file, ...readers], reverseGraph(graph))].filter(isTest).sort()
}

function generatorTests(given: readonly string[], graph: Graph, packageScripts: Readonly<Record<string, string>>): string[] {
  const generators = given.flatMap(file => generatorModules(file, packageScripts)).filter(module => graph.has(module))
  return generators.length === 0 ? [] : [...dependents(generators, reverseGraph(graph))].filter(isTest)
}

function withTests(run: LayeredRun, added: readonly string[]): LayeredRun {
  return added.length === 0 ? run : { kind: 'layers', layers: run.layers, tests: [...new Set([...run.tests, ...added])].sort() }
}

export function sessionRun(given: readonly string[], graph: Graph, testText: (test: string) => string, map: LayerMap = repositoryLayerMap()): SessionRun {
  const texts = new Map<string, string>()
  const moduleText = (module: string): string => texts.get(module) ?? texts.set(module, testText(module)).get(module)!
  const packageScripts = packageScriptsOf(() => moduleText(PACKAGE_MANIFEST))
  const derived = generatorTests(given, graph, packageScripts)
  const whole = selectRun(given, graph, moduleText, map)
  if (whole.kind === 'layers')
    return { run: withTests(whole, derived), why: 'the layers the change reaches' }
  const layers = new Set<string>()
  const tests = new Set<string>(derived)
  for (const file of given) {
    const one = selectRun([file], graph, moduleText, map)
    if (one.kind === 'layers') {
      one.layers.forEach(layer => layers.add(layer))
      one.tests.forEach(test => tests.add(test))
    }
    else {
      coveringTests(file, graph, moduleText, packageScripts).forEach(test => tests.add(test))
    }
  }
  return { run: { kind: 'layers', layers: [...layers].sort(), tests: [...tests].sort() }, why: `the covering tests of each path in place of the full run CI keeps: ${whole.why}` }
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

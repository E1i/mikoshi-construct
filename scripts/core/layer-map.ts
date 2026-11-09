import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FACTORY_FOLDERS, FACTORY_RUNTIME } from './factory-paths.js'
import { commandLine, GENERATED_FILES } from './generated-files.js'

export const LAYER_MAP = FACTORY_RUNTIME.layerMap

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

export interface LayerMap {
  files: Readonly<Record<string, string>>
  folders: Readonly<Record<string, string>>
  globals?: readonly string[]
}

export const DOCS_LAYER = 'docs'

const DOCUMENTS: readonly RegExp[] = [
  /^architecture\/.+\.(?:md|ya?ml)$/,
  /^docs\/.+/,
  /^\.claude\/skills\/.+\.md$/,
  /^\.claude\/commands\/[^/]+\.md$/,
  /^(?:README|SECURITY|CODE_OF_CONDUCT)\.md$/,
]

const TEST_INFRASTRUCTURE: readonly RegExp[] = [
  /^scripts\/ci\/(?:layers|select|prepush|test-command)\.ts$/,
  /^scripts\/tests\/ci\/(?:select-layers|prepush-selector)\.test\.ts$/,
  /^vitest(?:\.[\w-]+)*\.config\.[cm]?[jt]s$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^\.changeset\/config\.json$/,
  /^tests\/changesets-[\w-]+\.test\.ts$/,
]

const CHECK_PIPELINE: readonly RegExp[] = [
  /^vitest\.config\.ts$/,
  /^vitest-[^/]+\.ts$/,
  /^scripts\/scratch\/vitest-[^/]+$/,
  /^scripts\/ci\/.+$/,
]

const DOCUMENT_SAMPLE = 'any.md'

const FACTORY_TESTS = `${FACTORY_FOLDERS.tests[0]}/`
const SCRIPT_DIR = /^scripts\/([^/]+)\//
const SOURCE_FILE = /\.ts$/
const GLOB_SUFFIX = '/**'
const LAYERS_SEPARATOR = ','
const IMPORT_SPECIFIER = /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g
const NAMED_MODULE = /\b(?:scripts|src)\/[\w./-]+\.ts\b/g
const COMPILED_MODULE = /\.js$/
const RECORD_FOLDER = 'contract/'
const GLOBAL_FILES_RECORD = GENERATED_FILES.factory.path
const GLOBAL_FILES_REBUILD = commandLine(GENERATED_FILES.factory.rebuild)

export type ReadFile = (file: string) => string | null

export function readGlobalFiles(root: string = REPO_ROOT): string[] {
  const contract = JSON.parse(readFileSync(path.join(root, GLOBAL_FILES_RECORD), 'utf8')) as { globals?: { files: Record<string, string> } }
  if (contract.globals === undefined)
    throw new Error(`${GLOBAL_FILES_RECORD} carries no globals section; run ${GLOBAL_FILES_REBUILD}`)
  return Object.keys(contract.globals.files)
}

export function readLayerMap(root: string = REPO_ROOT): LayerMap {
  return { ...JSON.parse(readFileSync(path.join(root, LAYER_MAP), 'utf8')) as LayerMap, globals: readGlobalFiles(root) }
}

export function globalRunReason(map: LayerMap, file: string): string | null {
  return map.globals?.includes(file) === true ? `${file} is a global file of ${GLOBAL_FILES_RECORD}, which takes the full run` : null
}

export function layersIn(map: LayerMap, file: string): string[] {
  const entry = map.files[file]
  if (entry !== undefined)
    return [entry]
  return Object.entries(map.folders).filter(([folder]) => file.startsWith(folder)).map(([, layer]) => layer)
}

export function isDocument(file: string): boolean {
  return DOCUMENTS.some(pattern => pattern.test(file))
}

export function isTestInfrastructure(file: string): boolean {
  return TEST_INFRASTRUCTURE.some(pattern => pattern.test(file))
}

export function isCheckPipeline(file: string): boolean {
  return CHECK_PIPELINE.some(pattern => pattern.test(file))
}

function holdsOnlyDocuments(glob: string): boolean {
  return isDocument(`${glob.slice(0, -GLOB_SUFFIX.length)}/${DOCUMENT_SAMPLE}`)
}

export function isRecord(map: LayerMap, file: string): boolean {
  return file.startsWith(RECORD_FOLDER) && !SOURCE_FILE.test(file) && map.files[file] !== undefined
}

export function recordsOf(map: LayerMap): string[] {
  return Object.keys(map.files).filter(file => isRecord(map, file))
}

function isAsset(map: LayerMap, file: string): boolean {
  return !SOURCE_FILE.test(file) && !file.startsWith(FACTORY_TESTS) && !isRecord(map, file) && layersIn(map, file).length > 0
}

function directoryOf(file: string): string {
  return path.posix.dirname(file)
}

function layersOfTheCodeBeside(map: LayerMap, asset: string): string[] {
  const directory = directoryOf(asset)
  const beside = Object.entries(map.files).filter(([file]) => SOURCE_FILE.test(file) && directoryOf(file) === directory).map(([, layer]) => layer)
  return beside.length > 0 ? beside : layersIn(map, asset)
}

function isPlaced(map: LayerMap, file: string): boolean {
  return isRecord(map, file) || isAsset(map, file) || (!file.startsWith(FACTORY_TESTS) && SOURCE_FILE.test(file))
}

export function declaredLayersIn(map: LayerMap, file: string): string[] {
  if (isDocument(file))
    return [DOCS_LAYER]
  if (isAsset(map, file))
    return [...new Set(layersOfTheCodeBeside(map, file))].sort()
  return isPlaced(map, file) ? [...new Set(layersIn(map, file))].sort() : []
}

export function layersInOf(map: LayerMap, file: string): string[] {
  const declared = declaredLayersIn(map, file)
  if (declared.length > 0 || !isPlaced(map, file))
    return declared
  const folder = SCRIPT_DIR.exec(file)?.[1]
  return folder === undefined ? [] : [folder]
}

export function layersOfEntry(map: LayerMap, entry: string): string[] {
  if (!entry.endsWith(GLOB_SUFFIX))
    return declaredLayersIn(map, entry)
  return holdsOnlyDocuments(entry) ? [DOCS_LAYER] : layersIn(map, entry)
}

export function layerIn(map: LayerMap, file: string): string | null {
  const layers = layersInOf(map, file)
  return layers.length === 0 ? null : layers.join(LAYERS_SEPARATOR)
}

export const repositoryLayerMap = ((): (() => LayerMap) => {
  let read: LayerMap | undefined
  return () => read ??= readLayerMap()
})()

export function layerOf(file: string): string | null {
  return layerIn(repositoryLayerMap(), file)
}

export function layersOf(file: string): string[] {
  return layersInOf(repositoryLayerMap(), file)
}

function modulesNamedIn(file: string, text: string): { imported: string[], named: string[] } {
  const imported = [...text.matchAll(IMPORT_SPECIFIER)].map(match => path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1] ?? match[2]!)).replace(COMPILED_MODULE, '.ts'))
  return { imported, named: [...text.matchAll(NAMED_MODULE)].map(match => match[0]) }
}

export function layersReachedByImports(test: string, modules: ReadonlyMap<string, readonly string[]>, read: ReadFile, map: LayerMap): string[] | null {
  const layers = new Set<string>()
  const seen = new Set([test])
  const queue = [test]
  const place = (module: string): boolean => {
    const known = modules.get(module)
    for (const layer of known ?? layersInOf(map, module))
      layers.add(layer)
    return known !== undefined
  }
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const text = read(file)
    if (text === null)
      return null
    const { imported, named } = modulesNamedIn(file, text)
    for (const module of named)
      place(module)
    for (const module of imported.filter(each => !seen.has(each))) {
      seen.add(module)
      if (!place(module))
        queue.push(module)
    }
  }
  return [...layers]
}

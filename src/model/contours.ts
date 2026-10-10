import type { ReadFile } from './imports/specifiers.js'
import type { Contour, ContourKind } from './schema.js'
import path from 'node:path'
import { parseJsonc } from './imports/jsonc.js'
import { isRecord, strings } from './imports/specifiers.js'
import { leaves, workspacePackages } from './imports/workspaces.js'

export const ROOT_CONTOUR = '.'

const PACKAGE_MANIFEST = 'package.json'
const TSCONFIG = /(?:^|\/)tsconfig(?:\.[\w-]+)?\.json$/
const CONTRACT_DOCUMENT = /\.(?:json|ya?ml)$/
const CONTRACT_YAML_KEY = /^(?:openapi|asyncapi|swagger)\s*:/m
const CONTRACT_JSON_KEYS = ['openapi', 'asyncapi', 'swagger']
const JSON_SCHEMA_DIALECT = /^https?:\/\/json-schema\.org\//
const MANIFEST_ENTRY_KEYS = ['exports', 'main', 'module', 'types', 'bin']

export type ResolveEntry = (target: string) => string | null

interface Declared {
  id: string
  name: string
  kind: ContourKind
  declaredBy: string
  entries: string[]
}

function manifestEntries(directory: string, manifest: unknown, resolveEntry: ResolveEntry): string[] {
  if (!isRecord(manifest))
    return []
  const targets = MANIFEST_ENTRY_KEYS.flatMap(key => leaves(manifest[key]))
  return targets.flatMap((target) => {
    const resolved = resolveEntry(path.posix.normalize(path.posix.join(directory === ROOT_CONTOUR ? '' : directory, target)))
    return resolved == null ? [] : [resolved]
  })
}

function rootContour(rootName: string, tracked: Set<string>, read: ReadFile, resolveEntry: ResolveEntry): Declared {
  if (!tracked.has(PACKAGE_MANIFEST))
    return { id: ROOT_CONTOUR, name: rootName, kind: 'package', declaredBy: 'git ls-files -z', entries: [] }
  const manifest = parseJsonc(read(PACKAGE_MANIFEST) ?? '')
  const name = isRecord(manifest) && typeof manifest.name === 'string' && manifest.name.trim() !== '' ? manifest.name : rootName
  return { id: ROOT_CONTOUR, name, kind: 'package', declaredBy: PACKAGE_MANIFEST, entries: manifestEntries(ROOT_CONTOUR, manifest, resolveEntry) }
}

function referencedDirectory(config: string, reference: string): string {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(config), reference))
  return target.endsWith('.json') ? path.posix.dirname(target) : target
}

function referenceContours(files: string[], read: ReadFile): Declared[] {
  return files.filter(file => TSCONFIG.test(file)).flatMap((config) => {
    const parsed = parseJsonc(read(config) ?? '')
    const references = isRecord(parsed) && Array.isArray(parsed.references) ? parsed.references : []
    return references.flatMap((reference) => {
      const target = isRecord(reference) ? strings([reference.path])[0] : undefined
      if (target === undefined)
        return []
      const id = referencedDirectory(config, target)
      return id === ROOT_CONTOUR || id.startsWith('..') ? [] : [{ id, name: id, kind: 'reference' as const, declaredBy: config, entries: [] }]
    })
  })
}

export function declaresContract(file: string, text: string): boolean {
  if (!file.endsWith('.json'))
    return CONTRACT_YAML_KEY.test(text)
  const parsed = parseJsonc(text)
  if (!isRecord(parsed))
    return false
  return CONTRACT_JSON_KEYS.some(key => key in parsed) || (typeof parsed.$schema === 'string' && JSON_SCHEMA_DIALECT.test(parsed.$schema))
}

function contractContours(files: string[], read: ReadFile): Declared[] {
  const byDirectory = new Map<string, string[]>()
  for (const file of files) {
    if (!CONTRACT_DOCUMENT.test(file) || TSCONFIG.test(file) || path.posix.basename(file) === PACKAGE_MANIFEST)
      continue
    const text = read(file)
    if (text == null || !declaresContract(file, text))
      continue
    const directory = path.posix.dirname(file)
    const id = directory === ROOT_CONTOUR ? file : directory
    byDirectory.set(id, [...byDirectory.get(id) ?? [], file])
  }
  return [...byDirectory.entries()].map(([id, documents]) => ({ id, name: id, kind: 'contract' as const, declaredBy: documents[0], entries: documents }))
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function discoverContours(rootName: string, files: string[], read: ReadFile, resolveEntry: ResolveEntry): Contour[] {
  const tracked = new Set(files)
  const workspaces: Declared[] = workspacePackages(files, read).map(workspace => ({
    id: workspace.directory,
    name: workspace.name,
    kind: 'workspace',
    declaredBy: `${workspace.directory}/${PACKAGE_MANIFEST}`,
    entries: manifestEntries(workspace.directory, workspace.manifest, resolveEntry),
  }))
  const found = new Map<string, Declared>()
  for (const contour of [rootContour(rootName, tracked, read, resolveEntry), ...workspaces, ...referenceContours(files, read), ...contractContours(files, read)]) {
    if (!found.has(contour.id))
      found.set(contour.id, { ...contour, entries: [...new Set(contour.entries)].sort(compare) })
  }
  return [...found.values()].sort((left, right) => compare(left.id, right.id))
}

export function contourOf(file: string, contours: readonly Contour[]): string {
  let owner = ROOT_CONTOUR
  for (const contour of contours) {
    if (contour.id !== ROOT_CONTOUR && (file === contour.id || file.startsWith(`${contour.id}/`)) && contour.id.length > (owner === ROOT_CONTOUR ? 0 : owner.length))
      owner = contour.id
  }
  return owner
}

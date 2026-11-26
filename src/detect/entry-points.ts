import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { IGNORED_ENTRIES } from './ignored-entries.js'

export type EntryPointKind = 'bin' | 'main' | 'page' | 'endpoint'

export interface EntryPoint {
  kind: EntryPointKind
  path: string
  declaredIn: string | null
  packageDir: string
}

const PACKAGE_DIR = '(?:(?:apps|packages|libs|services)/[^/]+/)?'
const SCRIPT = '[cm]?[jt]sx?'
const CONVENTIONS: readonly (readonly [EntryPointKind, RegExp])[] = [
  ['endpoint', new RegExp(`^${PACKAGE_DIR}(?:src/)?pages/api/.+\\.${SCRIPT}$`)],
  ['endpoint', new RegExp(`^${PACKAGE_DIR}(?:src/)?app/(?:.+/)?route\\.${SCRIPT}$`)],
  ['endpoint', new RegExp(`^${PACKAGE_DIR}src/routes/(?:.+/)?\\+(?:server|page\\.server|layout\\.server)\\.${SCRIPT}$`)],
  ['page', new RegExp(`^${PACKAGE_DIR}(?:src/)?pages/.+\\.(?:${SCRIPT}|vue|svelte|astro|mdx?)$`)],
  ['page', new RegExp(`^${PACKAGE_DIR}(?:src/)?app/(?:.+/)?(?:page|layout)\\.${SCRIPT}$`)],
  ['page', new RegExp(`^${PACKAGE_DIR}src/routes/(?:.+/)?\\+(?:page|layout)\\.(?:svelte|${SCRIPT})$`)],
  ['page', new RegExp(`^${PACKAGE_DIR}index\\.html$`)],
]
const CONVENTION_ROOTS = ['pages', 'src/pages', 'app', 'src/app', 'src/routes']
const WORKSPACE_PARENTS = ['apps', 'packages', 'libs', 'services']
const PACKAGE_MANIFEST = 'package.json'
const SKIPPED_ENTRIES: ReadonlySet<string> = new Set([...IGNORED_ENTRIES, 'node_modules'])
const RELATIVE_SPECIFIER = /\b(?:from|import|require)\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro']
const COMPILED_TWIN: Readonly<Record<string, string[]>> = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] }

const PRODUCT_CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/
const TEST_NAMED = /\.(?:test|spec)\.[^/]+$/
const TEST_SEGMENTS: ReadonlySet<string> = new Set(['tests', 'test', '__tests__', 'e2e', 'fixtures'])
const NON_PRODUCT_ROOTS: ReadonlySet<string> = new Set(['scripts', 'docs', 'templates'])
const TOOL_CONFIG = /^[^/]+\.config\.[^/]+$/

function isHidden(segment: string): boolean {
  return segment.startsWith('.')
}

export function isProductSource(file: string): boolean {
  const segments = file.split('/')
  return PRODUCT_CODE.test(file)
    && !TEST_NAMED.test(file)
    && !TOOL_CONFIG.test(file)
    && !NON_PRODUCT_ROOTS.has(segments[0]!)
    && !segments.some(segment => TEST_SEGMENTS.has(segment) || isHidden(segment))
}

export function entryPointKindOf(relative: string): EntryPointKind | null {
  return CONVENTIONS.find(([, pattern]) => pattern.test(relative))?.[0] ?? null
}

export interface SourceTree {
  isFile: (file: string) => boolean
  read: (file: string) => string | null
  filesUnder: (dir: string) => string[]
  childDirs: (dir: string) => string[]
}

function statOf(file: string): { isFile: () => boolean, isDirectory: () => boolean } | null {
  try {
    return statSync(file)
  }
  catch {
    return null
  }
}

function posix(relative: string): string {
  return relative.split(path.sep).join('/')
}

export function fileSystemTree(dir: string): SourceTree {
  const root = path.resolve(dir)
  const isDirectory = (relative: string): boolean => statOf(path.join(root, relative))?.isDirectory() ?? false
  const filesUnder = (relative: string): string[] => {
    if (!isDirectory(relative))
      return []
    return readdirSync(path.join(root, relative), { withFileTypes: true })
      .filter(entry => !SKIPPED_ENTRIES.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap(entry => entry.isDirectory() ? filesUnder(`${relative}/${entry.name}`) : entry.isFile() ? [`${relative}/${entry.name}`] : [])
  }
  return {
    isFile: relative => statOf(path.join(root, relative))?.isFile() ?? false,
    read: (relative) => {
      try {
        return readFileSync(path.join(root, relative), 'utf8')
      }
      catch {
        return null
      }
    },
    filesUnder,
    childDirs: relative => isDirectory(relative) ? readdirSync(path.join(root, relative)).sort() : [],
  }
}

export function listedTree(listed: readonly string[], read: (file: string) => string | null): SourceTree {
  const files = new Set(listed)
  const sorted = [...files].sort()
  return {
    isFile: file => files.has(file),
    read: file => files.has(file) ? read(file) : null,
    filesUnder: dir => sorted.filter(file => file.startsWith(`${dir}/`)),
    childDirs: dir => [...new Set(sorted.filter(file => file.startsWith(`${dir}/`)).flatMap(file => file.slice(dir.length + 1).split('/').slice(0, -1).slice(0, 1)))],
  }
}

function packageDirs(tree: SourceTree): string[] {
  const workspaces = WORKSPACE_PARENTS.flatMap(parent => tree.childDirs(parent).map(entry => `${parent}/${entry}`).filter(dir => tree.isFile(`${dir}/${PACKAGE_MANIFEST}`)))
  return ['', ...workspaces]
}

function within(dir: string, relative: string): string {
  return posix(path.posix.normalize(dir === '' ? relative : `${dir}/${relative}`))
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string')
    return [value]
  if (value !== null && typeof value === 'object')
    return Object.values(value).flatMap(stringValues)
  return []
}

function declaredEntries(tree: SourceTree, dir: string): EntryPoint[] {
  const manifest = within(dir, PACKAGE_MANIFEST)
  let parsed: { bin?: unknown, main?: unknown, exports?: unknown } | null
  try {
    parsed = JSON.parse(tree.read(manifest) ?? 'null') as typeof parsed
  }
  catch {
    return []
  }
  const declared = (kind: EntryPointKind, value: unknown): EntryPoint[] => stringValues(value).map(file => ({ kind, path: within(dir, file), declaredIn: manifest, packageDir: dir }))
  return [...declared('bin', parsed?.bin), ...declared('main', parsed?.main), ...declared('main', parsed?.exports)]
}

function conventionalEntries(tree: SourceTree, dir: string): EntryPoint[] {
  const candidates = [within(dir, 'index.html'), ...CONVENTION_ROOTS.flatMap(conventional => tree.filesUnder(within(dir, conventional)))]
  return candidates.flatMap((file) => {
    const kind = tree.isFile(file) ? entryPointKindOf(file) : null
    return kind === null ? [] : [{ kind, path: file, declaredIn: null, packageDir: dir }]
  })
}

const WORKSPACE_PACKAGE = new RegExp(`^(?:${WORKSPACE_PARENTS.join('|')})/[^/]+(?=/)`)

export function packageDirIn(tree: SourceTree, relative: string, created: readonly string[] = []): string {
  const candidate = WORKSPACE_PACKAGE.exec(relative)?.[0]
  if (candidate === undefined)
    return ''
  const manifest = `${candidate}/${PACKAGE_MANIFEST}`
  return created.includes(manifest) || tree.isFile(manifest) ? candidate : ''
}

export function packageDirOf(dir: string, relative: string, created: readonly string[] = []): string {
  return packageDirIn(fileSystemTree(dir), relative, created)
}

export function entryPointsIn(tree: SourceTree): EntryPoint[] {
  const seen = new Set<string>()
  return packageDirs(tree).flatMap(pkg => [...declaredEntries(tree, pkg), ...conventionalEntries(tree, pkg)]).filter((entry) => {
    const key = `${entry.kind} ${entry.path}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

export function detectEntryPoints(dir: string): EntryPoint[] {
  return entryPointsIn(fileSystemTree(dir))
}

function resolvedSource(tree: SourceTree, candidate: string): string | null {
  const extension = path.posix.extname(candidate)
  const tries = [
    candidate,
    ...(COMPILED_TWIN[extension] ?? []).map(twin => `${candidate.slice(0, -extension.length)}${twin}`),
    ...SOURCE_EXTENSIONS.map(added => `${candidate}${added}`),
    ...SOURCE_EXTENSIONS.map(added => `${candidate}/index${added}`),
  ]
  return tries.find(file => !file.startsWith('../') && tree.isFile(file)) ?? null
}

function importedBy(tree: SourceTree, file: string): string[] {
  const from = path.posix.dirname(file)
  return [...(tree.read(file) ?? '').matchAll(RELATIVE_SPECIFIER)].flatMap(([, specifier]) => resolvedSource(tree, path.posix.normalize(`${from}/${specifier!}`)) ?? [])
}

export function importReachIn(tree: SourceTree, entries: readonly string[]): string[] {
  const reached = new Set<string>()
  const pending = entries.flatMap(entry => resolvedSource(tree, posix(path.posix.normalize(entry))) ?? [])
  while (pending.length > 0) {
    const file = pending.pop()!
    if (reached.has(file))
      continue
    reached.add(file)
    pending.push(...importedBy(tree, file).filter(next => !reached.has(next)))
  }
  return [...reached].sort()
}

export function importReach(dir: string, entries: readonly string[]): string[] {
  return importReachIn(fileSystemTree(dir), entries)
}

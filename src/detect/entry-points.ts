import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
const NON_PRODUCT_ROOTS: ReadonlySet<string> = new Set(['scripts', 'docs'])

export function isProductSource(file: string): boolean {
  const segments = file.split('/')
  return PRODUCT_CODE.test(file) && !TEST_NAMED.test(file) && !NON_PRODUCT_ROOTS.has(segments[0]!) && !segments.some(segment => TEST_SEGMENTS.has(segment))
}

export function entryPointKindOf(relative: string): EntryPointKind | null {
  return CONVENTIONS.find(([, pattern]) => pattern.test(relative))?.[0] ?? null
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  }
  catch {
    return false
  }
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory()
  }
  catch {
    return false
  }
}

function posix(relative: string): string {
  return relative.split(path.sep).join('/')
}

function filesUnder(root: string, relative: string): string[] {
  const absolute = path.join(root, relative)
  if (!isDirectory(absolute))
    return []
  return readdirSync(absolute, { withFileTypes: true })
    .filter(entry => !SKIPPED_ENTRIES.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? filesUnder(root, `${relative}/${entry.name}`) : entry.isFile() ? [`${relative}/${entry.name}`] : [])
}

function packageDirs(root: string): string[] {
  const workspaces = WORKSPACE_PARENTS.filter(parent => isDirectory(path.join(root, parent))).flatMap(parent =>
    readdirSync(path.join(root, parent)).sort().map(entry => `${parent}/${entry}`).filter(dir => existsSync(path.join(root, dir, PACKAGE_MANIFEST))))
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

function declaredEntries(root: string, dir: string): EntryPoint[] {
  const manifest = within(dir, PACKAGE_MANIFEST)
  let parsed: { bin?: unknown, main?: unknown, exports?: unknown } | null
  try {
    parsed = JSON.parse(readFileSync(path.join(root, manifest), 'utf8')) as typeof parsed
  }
  catch {
    return []
  }
  const declared = (kind: EntryPointKind, value: unknown): EntryPoint[] => stringValues(value).map(file => ({ kind, path: within(dir, file), declaredIn: manifest, packageDir: dir }))
  return [...declared('bin', parsed?.bin), ...declared('main', parsed?.main), ...declared('main', parsed?.exports)]
}

function conventionalEntries(root: string, dir: string): EntryPoint[] {
  const candidates = [within(dir, 'index.html'), ...CONVENTION_ROOTS.flatMap(conventional => filesUnder(root, within(dir, conventional)))]
  return candidates.flatMap((file) => {
    const kind = isFile(path.join(root, file)) ? entryPointKindOf(file) : null
    return kind === null ? [] : [{ kind, path: file, declaredIn: null, packageDir: dir }]
  })
}

const WORKSPACE_PACKAGE = new RegExp(`^(?:${WORKSPACE_PARENTS.join('|')})/[^/]+(?=/)`)

export function packageDirOf(dir: string, relative: string, created: readonly string[] = []): string {
  const candidate = WORKSPACE_PACKAGE.exec(relative)?.[0]
  if (candidate === undefined)
    return ''
  const manifest = `${candidate}/${PACKAGE_MANIFEST}`
  return created.includes(manifest) || isFile(path.join(path.resolve(dir), manifest)) ? candidate : ''
}

export function detectEntryPoints(dir: string): EntryPoint[] {
  const root = path.resolve(dir)
  const seen = new Set<string>()
  return packageDirs(root).flatMap(pkg => [...declaredEntries(root, pkg), ...conventionalEntries(root, pkg)]).filter((entry) => {
    const key = `${entry.kind} ${entry.path}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

function resolvedSource(root: string, candidate: string): string | null {
  const extension = path.posix.extname(candidate)
  const tries = [
    candidate,
    ...(COMPILED_TWIN[extension] ?? []).map(twin => `${candidate.slice(0, -extension.length)}${twin}`),
    ...SOURCE_EXTENSIONS.map(added => `${candidate}${added}`),
    ...SOURCE_EXTENSIONS.map(added => `${candidate}/index${added}`),
  ]
  return tries.find(file => !file.startsWith('../') && isFile(path.join(root, file))) ?? null
}

function importedBy(root: string, file: string): string[] {
  let text: string
  try {
    text = readFileSync(path.join(root, file), 'utf8')
  }
  catch {
    return []
  }
  const from = path.posix.dirname(file)
  return [...text.matchAll(RELATIVE_SPECIFIER)].flatMap(([, specifier]) => {
    const resolved = resolvedSource(root, path.posix.normalize(`${from}/${specifier!}`))
    return resolved === null ? [] : [resolved]
  })
}

export function importReach(dir: string, entries: readonly string[]): string[] {
  const root = path.resolve(dir)
  const reached = new Set<string>()
  const pending = entries.flatMap(entry => resolvedSource(root, posix(path.posix.normalize(entry))) ?? [])
  while (pending.length > 0) {
    const file = pending.pop()!
    if (reached.has(file))
      continue
    reached.add(file)
    pending.push(...importedBy(root, file).filter(next => !reached.has(next)))
  }
  return [...reached].sort()
}

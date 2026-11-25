import type { EntryPointKind } from '../../../src/detect/entry-points.js'
import path from 'node:path'
import { entryPointKindOf, isProductSource } from '../../../src/detect/entry-points.js'
import { processGit } from '../../ports/git.js'

export interface HeadReading {
  added: readonly string[]
  files: () => readonly string[]
  read: (file: string) => string | null
}

export interface HeadEntry {
  kind: EntryPointKind
  path: string
}

export interface UnreachedPackage {
  packageDir: string
  modules: string[]
  entries: HeadEntry[]
}

const PACKAGE_MANIFEST = 'package.json'
const WORKSPACE_PACKAGE = /^(?:apps|packages|libs|services)\/[^/]+(?=\/)/
const RELATIVE_SPECIFIER = /\b(?:from|import|require)\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro']
const COMPILED_TWIN: Readonly<Record<string, string[]>> = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] }
const BUILT_ROOT = 'dist/'
const SOURCE_ROOTS_OF_BUILT = ['src/', '']
const NAMED_ENTRY_POINTS = 5
const ROOT_PACKAGE = 'the root package'

export const UNREACHED_FINDING_HEAD = 'New product code that no entry point reaches'

function packageDirOf(file: string, files: ReadonlySet<string>): string {
  const candidate = WORKSPACE_PACKAGE.exec(file)?.[0]
  return candidate !== undefined && files.has(`${candidate}/${PACKAGE_MANIFEST}`) ? candidate : ''
}

function within(dir: string, relative: string): string {
  return path.posix.normalize(dir === '' ? relative : `${dir}/${relative}`)
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string')
    return [value]
  if (value !== null && typeof value === 'object')
    return Object.values(value).flatMap(stringValues)
  return []
}

function declaredEntries(head: HeadReading, dir: string): HeadEntry[] {
  let parsed: { bin?: unknown, main?: unknown, exports?: unknown } | null
  try {
    parsed = JSON.parse(head.read(within(dir, PACKAGE_MANIFEST)) ?? 'null') as typeof parsed
  }
  catch {
    return []
  }
  const declared = (kind: EntryPointKind, value: unknown): HeadEntry[] => stringValues(value).map(file => ({ kind, path: within(dir, file) }))
  return [...declared('bin', parsed?.bin), ...declared('main', parsed?.main), ...declared('main', parsed?.exports)]
}

function conventionalEntries(files: ReadonlySet<string>, dir: string): HeadEntry[] {
  return [...files].sort().flatMap((file) => {
    const kind = packageDirOf(file, files) === dir ? entryPointKindOf(file) : null
    return kind === null ? [] : [{ kind, path: file }]
  })
}

function sourcesOfBuilt(file: string, dir: string): string[] {
  const prefix = dir === '' ? '' : `${dir}/`
  const local = file.slice(prefix.length)
  if (!local.startsWith(BUILT_ROOT))
    return [file]
  const rest = local.slice(BUILT_ROOT.length)
  return [file, ...SOURCE_ROOTS_OF_BUILT.map(root => `${prefix}${root}${rest}`)]
}

function resolved(files: ReadonlySet<string>, candidate: string): string | null {
  const extension = path.posix.extname(candidate)
  const tries = [
    candidate,
    ...(COMPILED_TWIN[extension] ?? []).map(twin => `${candidate.slice(0, -extension.length)}${twin}`),
    ...SOURCE_EXTENSIONS.map(added => `${candidate}${added}`),
    ...SOURCE_EXTENSIONS.map(added => `${candidate}/index${added}`),
  ]
  return tries.find(file => !file.startsWith('../') && files.has(file)) ?? null
}

function importsOf(head: HeadReading, files: ReadonlySet<string>, file: string): string[] {
  const from = path.posix.dirname(file)
  return [...(head.read(file) ?? '').matchAll(RELATIVE_SPECIFIER)].flatMap(([, specifier]) => resolved(files, path.posix.normalize(`${from}/${specifier!}`)) ?? [])
}

function reachedFrom(head: HeadReading, files: ReadonlySet<string>, starts: readonly string[]): Set<string> {
  const reached = new Set<string>()
  const pending = starts.flatMap(start => resolved(files, path.posix.normalize(start)) ?? [])
  while (pending.length > 0) {
    const file = pending.pop()!
    if (reached.has(file))
      continue
    reached.add(file)
    pending.push(...importsOf(head, files, file).filter(next => !reached.has(next)))
  }
  return reached
}

function byPackage(modules: readonly string[], files: ReadonlySet<string>): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const file of modules)
    grouped.set(packageDirOf(file, files), [...grouped.get(packageDirOf(file, files)) ?? [], file])
  return grouped
}

export function unreachedModules(head: HeadReading): UnreachedPackage[] {
  const candidates = head.added.filter(file => isProductSource(file) && entryPointKindOf(file) === null)
  if (candidates.length === 0)
    return []
  const files = new Set(head.files())
  return [...byPackage(candidates, files)].flatMap(([packageDir, modules]) => {
    const entries = [...declaredEntries(head, packageDir), ...conventionalEntries(files, packageDir)]
    if (entries.length === 0)
      return []
    const reached = reachedFrom(head, files, entries.flatMap(entry => sourcesOfBuilt(entry.path, packageDir)))
    const unreached = modules.filter(file => !reached.has(file)).sort()
    return unreached.length === 0 ? [] : [{ packageDir, modules: unreached, entries }]
  })
}

function packageLine({ packageDir, modules, entries }: UnreachedPackage): string {
  const named = entries.slice(0, NAMED_ENTRY_POINTS).map(entry => `${entry.kind} ${entry.path}`).join(', ')
  return `${modules.join(', ')} in ${packageDir === '' ? ROOT_PACKAGE : `the package ${packageDir}`} (entry points: ${named}${entries.length > NAMED_ENTRY_POINTS ? ', …' : ''})`
}

export function unreachedFinding(unreached: readonly UnreachedPackage[]): string | null {
  if (unreached.length === 0)
    return null
  return `${UNREACHED_FINDING_HEAD}: ${unreached.map(packageLine).join('; ')}. The bus walked the relative imports from every entry point of the package at the head and none reaches these modules, so no user runs this code and a witness can pass on code nobody uses; import each from a module an entry point reaches, or declare it as an entry point.`
}

export interface Verdicted {
  verdict: 'pass' | 'changes'
  findings: string[]
}

export function withUnreached<R extends Verdicted>(review: R, finding: string | null): R {
  return finding === null ? review : { ...review, verdict: 'changes', findings: [finding, ...review.findings.filter(each => each !== finding)] }
}

export function reviewedOnTheHead<R extends Verdicted>(review: R, head: HeadReading): R {
  return withUnreached(review, unreachedFinding(unreachedModules(head)))
}

export type ReachSource = (head: string) => HeadReading

export type ReachGit = (repo: string, args: string[]) => string

function zList(output: string): string[] {
  return output.split('\0').filter(file => file !== '')
}

function shown(run: ReachGit, repo: string, head: string, file: string): string | null {
  try {
    return run(repo, ['show', `${head}:${file}`])
  }
  catch {
    return null
  }
}

export function gitReachSource(repo: string, run: ReachGit = (at, args) => processGit.read(at, args)): ReachSource {
  return (head) => {
    const base = run(repo, ['merge-base', 'origin/main', head]).trim()
    return {
      added: zList(run(repo, ['diff', '--no-renames', '--diff-filter=A', '--name-only', '-z', base, head])),
      files: () => zList(run(repo, ['ls-tree', '-r', '--name-only', '-z', head])),
      read: file => shown(run, repo, head, file),
    }
  }
}

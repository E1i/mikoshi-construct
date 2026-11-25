import type { EntryPointKind, SourceTree } from '../../../src/detect/entry-points.js'
import { entryPointKindOf, entryPointsIn, importReachIn, isProductSource, listedTree, packageDirIn } from '../../../src/detect/entry-points.js'
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

const BUILT_ROOT = 'dist/'
const SOURCE_ROOTS_OF_BUILT = ['src/', '']
const NAMED_ENTRY_POINTS = 5
const ROOT_PACKAGE = 'the root package'

export const UNREACHED_FINDING_HEAD = 'New product code that no entry point reaches'

function sourcesOfBuilt(file: string, dir: string): string[] {
  const prefix = dir === '' ? '' : `${dir}/`
  const local = file.slice(prefix.length)
  if (!local.startsWith(BUILT_ROOT))
    return [file]
  const rest = local.slice(BUILT_ROOT.length)
  return [file, ...SOURCE_ROOTS_OF_BUILT.map(root => `${prefix}${root}${rest}`)]
}

function byPackage(modules: readonly string[], tree: SourceTree): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const file of modules)
    grouped.set(packageDirIn(tree, file), [...grouped.get(packageDirIn(tree, file)) ?? [], file])
  return grouped
}

export function unreachedModules(head: HeadReading): UnreachedPackage[] {
  const candidates = head.added.filter(file => isProductSource(file) && entryPointKindOf(file) === null)
  if (candidates.length === 0)
    return []
  const tree = listedTree(head.files(), head.read)
  const entryPoints = entryPointsIn(tree)
  return [...byPackage(candidates, tree)].flatMap(([packageDir, modules]) => {
    const entries = entryPoints.filter(entry => entry.packageDir === packageDir).map(({ kind, path }) => ({ kind, path }))
    if (entries.length === 0)
      return []
    const reached = new Set(importReachIn(tree, entries.flatMap(entry => sourcesOfBuilt(entry.path, packageDir))))
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

import type { ContentionArea, Declarations, ModuleDeclaration } from '../declarations.js'
import { matches, ownershipOf, readDeclarations } from '../declarations.js'

export interface OverlapDeclarations {
  modules: readonly ModuleDeclaration[]
  contention: readonly ContentionArea[]
  derived: readonly string[]
}

export const NO_DECLARATIONS: OverlapDeclarations = { modules: [], contention: [], derived: [] }

export function overlapDeclarationsOf(declarations: Pick<Declarations, 'modules' | 'contention' | 'generated'>): OverlapDeclarations {
  return { modules: declarations.modules, contention: declarations.contention, derived: declarations.generated.map(row => row.path) }
}

export function orderDeclarationsAt(root: string): OverlapDeclarations {
  return overlapDeclarationsOf(readDeclarations(root))
}

export function effectivePaths(paths: Iterable<string>, declarations: OverlapDeclarations): string[] {
  return [...new Set(paths)].filter(file => !declarations.derived.includes(file)).sort()
}

export function areasOf(paths: Iterable<string>, declarations: OverlapDeclarations): string[] {
  const files = effectivePaths(paths, declarations)
  return declarations.contention.filter(area => files.some(file => area.paths.some(entry => matches(entry, file)))).map(area => area.id).sort()
}

export function modulesOf(paths: Iterable<string>, declarations: OverlapDeclarations): string[] {
  return [...new Set(effectivePaths(paths, declarations).flatMap((file) => {
    const owner = ownershipOf(declarations.modules, file).owner
    return owner === null ? [] : [owner]
  }))].sort()
}

export function overlaps(a: Iterable<string>, b: Iterable<string>, declarations: OverlapDeclarations): boolean {
  const left = effectivePaths(a, declarations)
  const right = new Set(effectivePaths(b, declarations))
  if (left.some(file => right.has(file)))
    return true
  const leftAreas = areasOf(left, declarations)
  return areasOf(right, declarations).some(area => leftAreas.includes(area))
}

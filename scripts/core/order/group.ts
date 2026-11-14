import type { OverlapDeclarations } from './overlap.js'
import { modulesOf, overlaps } from './overlap.js'

export interface PrPaths {
  pr: number
  paths: readonly string[]
}

export interface PrGroup {
  prs: readonly number[]
  modules: readonly string[]
}

function rootOf(parents: number[], at: number): number {
  let root = at
  while (parents[root] !== root)
    root = parents[root]!
  return root
}

export function groupsOf(prs: readonly PrPaths[], declarations: OverlapDeclarations): PrGroup[] {
  const ordered = [...prs].sort((a, b) => a.pr - b.pr)
  const parents = ordered.map((_, at) => at)
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      if (overlaps(ordered[left]!.paths, ordered[right]!.paths, declarations))
        parents[rootOf(parents, right)] = rootOf(parents, left)
    }
  }
  const components = new Map<number, PrPaths[]>()
  ordered.forEach((entry, at) => {
    const root = rootOf(parents, at)
    components.set(root, [...components.get(root) ?? [], entry])
  })
  return [...components.values()].map(members => ({
    prs: members.map(member => member.pr),
    modules: modulesOf(members.flatMap(member => member.paths), declarations),
  }))
}

export function groupOf(groups: readonly PrGroup[], pr: number): PrGroup | null {
  return groups.find(group => group.prs.includes(pr)) ?? null
}

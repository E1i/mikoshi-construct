import type { MapMechanics } from '../src/atlas/components.js'
import type { Contour, Relation } from '../src/model/schema.js'
import { describe, expect, it } from 'vitest'
import { componentMap } from '../src/atlas/components.js'

const CONTOURS: Contour[] = [
  { id: '.', name: 'shop', kind: 'package', declaredBy: 'package.json', entries: [] },
  { id: 'packages/app', name: '@shop/app', kind: 'workspace', declaredBy: 'packages/app/package.json', entries: [] },
  { id: 'packages/core', name: '@shop/core', kind: 'workspace', declaredBy: 'packages/core/package.json', entries: ['packages/core/src/index.ts'] },
]

const FILES = ['packages/app/src/main.ts', 'packages/app/src/log.ts', 'packages/core/src/index.ts', 'packages/core/src/price.ts', 'tools/seed.ts']

function relation(from: string, to: string, line: number): Relation {
  return { from, to, kind: 'imports', specifier: to, status: 'found', source: { path: from, line } }
}

function mechanics(relations: Relation[]): MapMechanics {
  return { contours: CONTOURS, components: FILES.map(file => ({ id: file, path: file, relations: 'found' as const })), relations }
}

function contourArrows(relations: Relation[]): string[] {
  return componentMap(mechanics(relations), [], 'shop').arrows.filter(arrow => arrow.from.startsWith('c:') && arrow.to.startsWith('c:')).map(arrow => `${arrow.from} → ${arrow.to} ${arrow.crossing} ${arrow.count}`)
}

describe('an arrow names how it crosses into the contour it reaches', () => {
  it('goes through a contour\'s declared entry, past it as a bypass, or directly into a contour that declares none', () => {
    expect(contourArrows([
      relation('packages/app/src/main.ts', 'packages/core/src/index.ts', 1),
      relation('packages/app/src/main.ts', 'packages/core/src/price.ts', 2),
      relation('tools/seed.ts', 'packages/app/src/log.ts', 1),
    ])).toEqual([
      'c:. → c:packages/app direct 1',
      'c:packages/app → c:packages/core bypass 1',
      'c:packages/app → c:packages/core through 1',
    ])
  })

  it('draws no contour arrow for a relation inside one contour, and an inside arrow between its components', () => {
    const map = componentMap(mechanics([relation('packages/core/src/index.ts', 'packages/core/src/price.ts', 1)]), [{ id: 'entry', contour: 'packages/core', name: 'Entry', purpose: 'Re-exports', files: ['packages/core/src/index.ts'] }], 'shop')
    expect(map.arrows.map(arrow => `${arrow.from} → ${arrow.to} ${arrow.crossing}`)).toEqual(['k:packages/core:entry → k:packages/core:dir:packages/core/src inside'])
  })

  it('counts every relation under an arrow and gives at most three of them as examples, in the order they stand', () => {
    const relations = [1, 2, 3, 4, 5].map(line => relation('packages/app/src/main.ts', 'packages/core/src/price.ts', line))
    const arrow = componentMap(mechanics(relations), [], 'shop').arrows.find(entry => entry.from === 'c:packages/app' && entry.to === 'c:packages/core')!
    expect(arrow).toEqual({ from: 'c:packages/app', to: 'c:packages/core', crossing: 'bypass', count: 5, examples: ['packages/app/src/main.ts:1', 'packages/app/src/main.ts:2', 'packages/app/src/main.ts:3'] })
  })

  it('leaves out a relation whose target is unknown, since no arrow may stand on what was not found', () => {
    const unresolved: Relation = { from: 'packages/app/src/main.ts', to: null, kind: 'imports', specifier: './gone.js', status: 'unknown', source: { path: 'packages/app/src/main.ts', line: 9 } }
    expect(componentMap(mechanics([unresolved]), [], 'shop').arrows).toEqual([])
  })
})

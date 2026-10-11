import type { ComponentMap, MapMechanics } from '../src/atlas/components.js'
import type { Contour, Mechanics, Relation } from '../src/model/schema.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { componentMap, MAX_DEFAULT_NODES, visibleArrows, visibleNodes } from '../src/atlas/components.js'
import { contourOf } from '../src/model/contours.js'
import { discoverMechanics, writeEngram } from '../src/model/discovery.js'
import { readModel } from '../src/model/write.js'

const MIKOSHI = path.resolve(import.meta.dirname, '..')
const CODE_KINDS: ReadonlySet<Relation['kind']> = new Set(['imports', 'calls'])

function repository(tree: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-components-'))
  for (const [file, content] of Object.entries(tree)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return dir
}

const SHOP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', private: true }),
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'packages/core/package.json': JSON.stringify({ name: '@shop/core', exports: { '.': './src/index.ts' } }),
  'packages/core/src/index.ts': 'export { price } from \'./price.js\'\n',
  'packages/core/src/price.ts': 'export function price(): number {\n  return 1\n}\n',
  'packages/app/package.json': JSON.stringify({ name: '@shop/app' }),
  'packages/app/src/main.ts': 'import { price } from \'@shop/core\'\nimport { price as raw } from \'../../core/src/price.js\'\nimport { log } from \'./log.js\'\n\nlog(price() + raw())\n',
  'packages/app/src/log.ts': 'export function log(value: number): void {\n  void value\n}\n',
  'README.md': '# shop\n',
}

let mikoshi: Mechanics | undefined

function mikoshiMechanics(): Mechanics {
  mikoshi ??= discoverMechanics(MIKOSHI)
  return mikoshi
}

function filesUnder(map: ComponentMap, contours: Contour[], node: string): (file: string) => boolean {
  const group = map.groups.find(entry => entry.id === node)
  if (group !== undefined)
    return file => group.contours.includes(`c:${contourOf(file, contours)}`)
  if (node.startsWith('c:'))
    return file => contourOf(file, contours) === node.slice(2)
  const component = map.contours.flatMap(contour => contour.components).find(entry => entry.id === node)
  const held = new Set(component?.files.filter(file => file.state !== 'absent').map(file => file.path))
  return file => held.has(file)
}

function crossing(relation: Relation & { to: string }, contours: Contour[]): string {
  const from = contourOf(relation.from, contours)
  const to = contourOf(relation.to, contours)
  if (from === to)
    return 'inside'
  const entries = contours.find(contour => contour.id === to)?.entries ?? []
  if (entries.length === 0)
    return 'direct'
  return entries.includes(relation.to) ? 'through' : 'bypass'
}

function unproven(mechanics: MapMechanics, map: ComponentMap): string[] {
  const contours = mechanics.contours
  const found = mechanics.relations.filter((relation): relation is Relation & { to: string } => relation.status === 'found' && relation.to != null && CODE_KINDS.has(relation.kind))
  return map.arrows.flatMap((arrow) => {
    const leaves = filesUnder(map, contours, arrow.from)
    const lands = filesUnder(map, contours, arrow.to)
    const standing = found.filter(relation => leaves(relation.from) && lands(relation.to) && crossing(relation, contours) === arrow.crossing)
    const at = new Set(standing.map(relation => `${relation.source.path}:${relation.source.line}`))
    const problems: string[] = []
    if (standing.length !== arrow.count)
      problems.push(`${arrow.from} → ${arrow.to} counts ${arrow.count}, ${standing.length} relations stand under it`)
    if (arrow.examples.length !== Math.min(3, standing.length) || !arrow.examples.every(example => at.has(example)))
      problems.push(`${arrow.from} → ${arrow.to} gives ${arrow.examples.join(', ')}, which are not ${Math.min(3, standing.length)} of its relations`)
    return problems
  })
}

function unshown(mechanics: MapMechanics, map: ComponentMap): string[] {
  return mechanics.relations
    .filter((relation): relation is Relation & { to: string } => relation.status === 'found' && relation.to != null && CODE_KINDS.has(relation.kind))
    .filter(relation => contourOf(relation.from, mechanics.contours) !== contourOf(relation.to, mechanics.contours))
    .filter(relation => !map.arrows.some(arrow => arrow.from === `c:${contourOf(relation.from, mechanics.contours)}` && arrow.to === `c:${contourOf(relation.to, mechanics.contours)}` && arrow.examples.length > 0))
    .map(relation => `${relation.source.path}:${relation.source.line}`)
}

function workspaces(count: number): MapMechanics {
  const contours: Contour[] = [{ id: '.', name: 'many', kind: 'package', declaredBy: 'package.json', entries: [] }]
  const components: Mechanics['components'] = []
  for (let index = 0; index < count; index += 1) {
    const id = `packages/p${String(index).padStart(2, '0')}`
    contours.push({ id, name: id, kind: 'workspace', declaredBy: `${id}/package.json`, entries: [] })
    for (const part of ['a', 'b'])
      components.push({ id: `${id}/${part}/x.ts`, path: `${id}/${part}/x.ts`, relations: 'found' })
  }
  return { contours, components, relations: [] }
}

describe('the view of a repository', () => {
  it('on mikoshi-construct the top level of the view has at most 30 nodes', () => {
    const mechanics = mikoshiMechanics()
    const map = componentMap(mechanics, readModel(MIKOSHI)?.interpretation?.components ?? [], 'mikoshi-construct')
    const shown = visibleNodes(map)
    expect(shown.length).toBeGreaterThan(1)
    expect(shown.length).toBeLessThanOrEqual(MAX_DEFAULT_NODES)
    expect(map.contours.flatMap(contour => contour.components.flatMap(component => component.files.map(file => file.path))).sort()).toEqual(mechanics.components.map(component => component.path).sort())
  })

  it('folds more than 30 declared contours into groups by their parent directory, so the top level still has at most 30 nodes', () => {
    const map = componentMap(workspaces(40), [], 'many')
    expect(map.groups.map(group => [group.id, group.contours.length])).toEqual([['g:packages', 40]])
    expect(visibleNodes(map)).toEqual(['c:.', 'g:packages'])
    expect(visibleNodes(map, ['g:packages']).length).toBe(41)
    expect(componentMap(workspaces(20), [], 'few').groups).toEqual([])
  })

  it.each([
    ['contours under distinct parents fold into one group at the root', (index: number) => `p${index}/pkg`, [['g:.', 40]], ['c:.', 'g:.']],
    ['service apis fold by their shared prefix', (index: number) => `services/s${index}/api`, [['g:services', 40]], ['c:.', 'g:services']],
  ])('folds by a shorter shared prefix when no two of more than 30 contours share a parent: %s', (_, at, groups, shown) => {
    const many: MapMechanics = { contours: [{ id: '.', name: 'many', kind: 'package', declaredBy: 'package.json', entries: [] }], components: [], relations: [] }
    for (let index = 0; index < 40; index += 1) {
      many.contours.push({ id: at(index), name: at(index), kind: 'workspace', declaredBy: `${at(index)}/package.json`, entries: [] })
      many.components.push({ id: `${at(index)}/a.ts`, path: `${at(index)}/a.ts`, relations: 'found' })
    }
    const map = componentMap(many, [], 'many')
    expect(map.groups.map(group => [group.id, group.contours.length])).toEqual(groups)
    expect(visibleNodes(map)).toEqual(shown)
    expect(visibleNodes(map).length).toBeLessThanOrEqual(MAX_DEFAULT_NODES)
  })

  it('draws a tracked file of a component whose contour is not declared by its real state, under the root, and names the contour', () => {
    const mechanics: MapMechanics = {
      contours: [{ id: '.', name: 'r', kind: 'package', declaredBy: 'package.json', entries: [] }, { id: 'p1/pkg', name: 'p1/pkg', kind: 'workspace', declaredBy: 'p1/pkg/package.json', entries: [] }],
      components: [{ id: 'p1/pkg/a.ts', path: 'p1/pkg/a.ts', relations: 'found' }, { id: 'p1/pkg/b.ts', path: 'p1/pkg/b.ts', relations: 'found' }],
      relations: [],
    }
    const map = componentMap(mechanics, [{ id: 'x', contour: 'nope', name: 'X', purpose: 'Names a contour nobody declares', files: ['p1/pkg/a.ts', 'p1/pkg/gone.ts'] }], 'r')
    const root = map.contours.find(contour => contour.id === 'c:.')!
    const named = root.components.find(component => component.name === 'X')!
    expect(named.undeclaredContour).toBe('nope')
    expect(named.files.map(file => [file.path, file.state])).toEqual([['p1/pkg/a.ts', 'held'], ['p1/pkg/gone.ts', 'absent']])
    const pkg = map.contours.find(contour => contour.id === 'c:p1/pkg')!
    expect(pkg.components.flatMap(component => component.files.map(file => file.path))).toEqual(['p1/pkg/b.ts'])
    expect(pkg.state).toBe('held')
    expect(map.contours.flatMap(contour => contour.components.flatMap(component => component.files.filter(file => file.state !== 'absent').map(file => file.path))).sort()).toEqual(['p1/pkg/a.ts', 'p1/pkg/b.ts'])
  })

  it('marks a read file named under a declared contour that does not hold it as misplaced, drawn once by its real state', () => {
    const mechanics: MapMechanics = {
      contours: ['.', 'packages/a', 'packages/b'].map(id => ({ id, name: id, kind: 'workspace' as const, declaredBy: `${id}/package.json`, entries: [] })),
      components: [{ id: 'packages/a/x.ts', path: 'packages/a/x.ts', relations: 'found' }],
      relations: [],
    }
    const map = componentMap(mechanics, [{ id: 'wrong', contour: 'packages/b', name: 'Wrong', purpose: 'Names a file another contour holds', files: ['packages/a/x.ts', 'packages/b/gone.ts'] }], 'r')
    const drawn = map.contours.flatMap(contour => contour.components.flatMap(component => component.files.map(file => [contour.id, file.path, file.state])))
    expect(drawn).toEqual([['c:packages/a', 'packages/a/x.ts', 'held'], ['c:packages/b', 'packages/b/gone.ts', 'absent']])
    const named = map.contours.find(contour => contour.id === 'c:packages/b')!.components.find(component => component.name === 'Wrong')!
    expect(named.misplaced).toEqual(['packages/a/x.ts'])
    expect(named.counts).toEqual({ held: 0, unknown: 0, absent: 1 })
  })

  it('unfolds the contours at first sight while the view stays within 30 nodes, and no further', () => {
    const map = componentMap(workspaces(20), [], 'few')
    expect(map.open.length).toBeGreaterThan(0)
    expect(visibleNodes(map).length).toBeLessThanOrEqual(MAX_DEFAULT_NODES)
    expect(visibleNodes(map, [...map.open, ...map.contours.map(contour => contour.id).filter(id => !map.open.includes(id))]).length).toBeGreaterThan(MAX_DEFAULT_NODES)
  })

  it('counts held, unknown and absent files on every level, a parent the sum of its children', () => {
    const mechanics = discoverMechanics(repository(SHOP))
    const map = componentMap(mechanics, [{ id: 'gone', contour: 'packages/app', name: 'Gone', purpose: 'Names a file the tree lost', files: ['packages/app/src/old.ts'] }], 'shop')
    for (const contour of map.contours) {
      const files = contour.components.flatMap(component => component.files)
      expect(contour.counts).toEqual({ held: files.filter(file => file.state === 'held').length, unknown: files.filter(file => file.state === 'unknown').length, absent: files.filter(file => file.state === 'absent').length })
    }
    const app = map.contours.find(contour => contour.id === 'c:packages/app')!
    expect(app.state).toBe('absent')
    expect(app.components.find(component => component.name === 'Gone')?.counts).toEqual({ held: 0, unknown: 0, absent: 1 })
  })
})

describe('the arrows of the view', () => {
  it('every arrow stands on a proven relation and its example path:line is one of them', () => {
    for (const mechanics of [mikoshiMechanics(), discoverMechanics(repository(SHOP))]) {
      const map = componentMap(mechanics, [], 'repository')
      expect(map.arrows.length).toBeGreaterThan(0)
      expect(unproven(mechanics, map)).toEqual([])
      expect(unshown(mechanics, map)).toEqual([])
      expect(visibleArrows(map).every(arrow => visibleNodes(map).includes(arrow.from) && visibleNodes(map).includes(arrow.to))).toBe(true)
    }
  })
})

describe('the clustering an agent writes', () => {
  it('the clustering is an interpretation layer and the facts are byte-identical with and without it', () => {
    const root = repository(SHOP)
    const home = mkdtempSync(path.join(tmpdir(), 'atlas-components-home-'))
    const engram = writeEngram(root, { attached: true, home })
    const without = readFileSync(engram, 'utf8')
    const layer = { authoredBy: 'discovery', components: [{ id: 'pricing', contour: 'packages/core', name: 'Pricing', purpose: 'Computes what an order costs', files: ['packages/core/src/index.ts', 'packages/core/src/price.ts'] }] }
    writeFileSync(engram, `${JSON.stringify({ ...JSON.parse(without) as object, interpretation: layer }, null, 2)}\n`)
    writeEngram(root, { attached: true, home })
    const withLayer = JSON.parse(readFileSync(engram, 'utf8')) as Record<string, unknown>
    expect(withLayer.interpretation).toEqual(layer)
    expect(JSON.stringify(withLayer.mechanics)).toBe(JSON.stringify((JSON.parse(without) as Record<string, unknown>).mechanics))
    const { interpretation, ...facts } = withLayer
    expect(`${JSON.stringify(facts, null, 2)}\n`).toBe(without)
    expect(interpretation).toBeDefined()

    const model = readModel(path.dirname(engram))!
    const interpreted = componentMap(model.mechanics!, model.interpretation!.components, 'shop')
    const plain = componentMap(model.mechanics!, [], 'shop')
    const core = (map: ComponentMap): ComponentMap['contours'][number] => map.contours.find(contour => contour.id === 'c:packages/core')!
    expect(core(interpreted).components.map(component => [component.name, component.purpose, component.files.map(file => file.path)])).toEqual([
      ['Pricing', 'Computes what an order costs', ['packages/core/src/index.ts', 'packages/core/src/price.ts']],
      ['@shop/core', null, ['packages/core/package.json']],
    ])
    expect(core(plain).components.every(component => component.purpose === null)).toBe(true)
    expect(interpreted.relations).toEqual(plain.relations)
  })
})

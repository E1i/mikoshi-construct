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
  const found = mechanics.relations.filter((relation): relation is Relation & { to: string } => relation.status === 'found' && relation.to != null)
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
    .filter((relation): relation is Relation & { to: string } => relation.status === 'found' && relation.to != null)
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

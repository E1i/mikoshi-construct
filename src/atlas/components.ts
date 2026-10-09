import type { ComponentReason, Contour, ContourKind, InterpretedComponent, Mechanics, Relation } from '../model/schema.js'
import { contourOf, ROOT_CONTOUR } from '../model/contours.js'

export type MapMechanics = Pick<Mechanics, 'contours' | 'components' | 'relations'>

export const MAP_STATES = ['held', 'unknown', 'absent'] as const
export type MapState = (typeof MAP_STATES)[number]

export const CROSSINGS = ['inside', 'through', 'bypass', 'direct'] as const
export type Crossing = (typeof CROSSINGS)[number]

export const MAX_DEFAULT_NODES = 30
export const COMPONENT_LIMIT = 24
const SPLIT_WIDTH = 6
const EXAMPLE_LIMIT = 3

export type StateCounts = Record<MapState, number>

export interface MapFile {
  path: string
  state: MapState
  reason: ComponentReason | null
}

export interface MapComponent {
  id: string
  contour: string
  name: string
  purpose: string | null
  files: MapFile[]
  state: MapState
  counts: StateCounts
}

export interface MapContour {
  id: string
  name: string
  kind: ContourKind
  declaredBy: string
  entries: string[]
  components: MapComponent[]
  state: MapState
  counts: StateCounts
}

export interface MapRelation {
  from: string
  to: string
  at: string
  crossing: Crossing
}

export interface MapArrow {
  from: string
  to: string
  crossing: Crossing
  count: number
  examples: string[]
}

export interface ComponentMap {
  contours: MapContour[]
  relations: MapRelation[]
  arrows: MapArrow[]
  open: string[]
}

function contourNode(id: string): string {
  return `c:${id}`
}

function componentNode(contour: string, id: string): string {
  return `k:${contour}:${id}`
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function countsOf(states: MapState[]): StateCounts {
  const counts: StateCounts = { held: 0, unknown: 0, absent: 0 }
  for (const state of states)
    counts[state] += 1
  return counts
}

function stateOf(counts: StateCounts): MapState {
  if (counts.absent > 0)
    return 'absent'
  return counts.held > 0 ? 'held' : 'unknown'
}

function sum(all: StateCounts[]): StateCounts {
  return all.reduce((total, counts) => ({ held: total.held + counts.held, unknown: total.unknown + counts.unknown, absent: total.absent + counts.absent }), { held: 0, unknown: 0, absent: 0 })
}

function relativeTo(contour: string, file: string): string {
  return contour === ROOT_CONTOUR ? file : file.slice(contour.length + 1)
}

function groupKey(contour: string, file: string, depth: number): string {
  const segments = relativeTo(contour, file).split('/').slice(0, -1).slice(0, depth)
  const prefix = segments.join('/')
  if (prefix === '')
    return contour
  return contour === ROOT_CONTOUR ? prefix : `${contour}/${prefix}`
}

interface DirectoryGroup {
  key: string
  depth: number
  files: string[]
  rest: boolean
}

function splitGroup(contour: string, group: DirectoryGroup): DirectoryGroup[] {
  const parts = new Map<string, string[]>()
  for (const file of group.files) {
    const key = groupKey(contour, file, group.depth + 1)
    parts.set(key, [...parts.get(key) ?? [], file])
  }
  return [...parts.entries()]
    .map(([key, files]) => ({ key, depth: group.depth + 1, files, rest: false }))
    .sort((left, right) => right.files.length - left.files.length || compare(left.key, right.key))
}

type Weight = (file: string) => number

function splitOf(contour: string, group: DirectoryGroup, room: number): DirectoryGroup[] | null {
  const parts = splitGroup(contour, group)
  const share = group.files.length / (2 * SPLIT_WIDTH)
  const kept = parts.filter(part => part.files.length >= share).slice(0, parts.length <= room ? room : room - 1)
  const left = parts.filter(part => !kept.includes(part)).flatMap(part => part.files)
  const split = [...kept, ...left.length === 0 ? [] : [{ key: group.key, depth: group.depth, files: left, rest: true }]]
  return split.length > 1 && split.length <= room ? split : null
}

function directoryGroups(contour: string, files: string[], weight: Weight = () => 1): DirectoryGroup[] {
  const weightOf = (group: DirectoryGroup): number => group.files.reduce((total, file) => total + weight(file), 0)
  const heaviest = (left: DirectoryGroup, right: DirectoryGroup): number => weightOf(right) - weightOf(left) || compare(left.key, right.key)
  let groups = splitGroup(contour, { key: contour, depth: 0, files, rest: false })
  const settled = new Set<DirectoryGroup>()
  for (;;) {
    const room = Math.min(SPLIT_WIDTH, COMPONENT_LIMIT - groups.length + 1)
    const chosen = room < 2 ? undefined : [...groups].sort(heaviest).find(group => !group.rest && !settled.has(group))
    if (chosen === undefined)
      break
    const split = splitOf(contour, chosen, room)
    if (split == null)
      settled.add(chosen)
    else
      groups = [...groups.filter(group => group !== chosen), ...split]
  }
  return groups.sort((left, right) => compare(left.key, right.key) || Number(left.rest) - Number(right.rest))
}

function groupName(group: DirectoryGroup, contour: Contour): string {
  const name = group.key === contour.id ? contour.name : group.key
  return group.rest ? `${name}/*` : name
}

function fileOf(file: string, read: Map<string, MapFile>): MapFile {
  return read.get(file) ?? { path: file, state: 'absent', reason: null }
}

function component(contour: string, id: string, name: string, purpose: string | null, files: MapFile[]): MapComponent {
  const counts = countsOf(files.map(file => file.state))
  return { id: componentNode(contour, id), contour, name, purpose, files, state: stateOf(counts), counts }
}

function interpretedFor(contour: Contour, interpreted: readonly InterpretedComponent[], filesOf: Map<string, string[]>): InterpretedComponent[] {
  const declared = new Set(filesOf.keys())
  return interpreted.filter(entry => entry.contour === contour.id || (contour.id === ROOT_CONTOUR && !declared.has(entry.contour)))
}

function componentsOf(contour: Contour, interpreted: readonly InterpretedComponent[], filesOf: Map<string, string[]>, read: Map<string, MapFile>): MapComponent[] {
  const own = new Set(filesOf.get(contour.id) ?? [])
  const claimed = new Set<string>()
  const named = interpretedFor(contour, interpreted, filesOf).map((entry) => {
    const files = entry.files.map((file) => {
      const inContour = entry.contour === contour.id && own.has(file)
      if (inContour)
        claimed.add(file)
      return inContour ? fileOf(file, read) : { path: file, state: 'absent' as const, reason: null }
    })
    return component(contour.id, entry.id, entry.name, entry.purpose, files)
  })
  const rest = [...own].filter(file => !claimed.has(file)).sort(compare)
  const groups = directoryGroups(contour.id, rest, file => read.get(file)?.state === 'held' ? 1 : 0).map(group => component(contour.id, `${group.rest ? 'rest' : 'dir'}:${group.key}`, groupName(group, contour), null, group.files.map(file => fileOf(file, read))))
  return [...named, ...groups]
}

function crossingOf(relation: Relation & { to: string }, owner: (file: string) => string, entries: Map<string, Set<string>>): Crossing {
  const from = owner(relation.from)
  const to = owner(relation.to)
  if (from === to)
    return 'inside'
  const declared = entries.get(to) ?? new Set()
  if (declared.size === 0)
    return 'direct'
  return declared.has(relation.to) ? 'through' : 'bypass'
}

function arrowsOf(relations: MapRelation[], contourOfFile: (file: string) => string, componentOfFile: Map<string, string>): MapArrow[] {
  const arrows = new Map<string, MapArrow>()
  const add = (from: string, to: string, relation: MapRelation): void => {
    const key = [from, to, relation.crossing].join('\u0000')
    const arrow = arrows.get(key) ?? { from, to, crossing: relation.crossing, count: 0, examples: [] }
    arrow.count += 1
    if (arrow.examples.length < EXAMPLE_LIMIT)
      arrow.examples.push(relation.at)
    arrows.set(key, arrow)
  }
  for (const relation of relations) {
    const fromContour = contourNode(contourOfFile(relation.from))
    const toContour = contourNode(contourOfFile(relation.to))
    const fromComponent = componentOfFile.get(relation.from)
    const toComponent = componentOfFile.get(relation.to)
    if (fromContour !== toContour) {
      add(fromContour, toContour, relation)
      if (toComponent !== undefined)
        add(fromContour, toComponent, relation)
      if (fromComponent !== undefined)
        add(fromComponent, toContour, relation)
    }
    if (fromComponent !== undefined && toComponent !== undefined && fromComponent !== toComponent)
      add(fromComponent, toComponent, relation)
  }
  return [...arrows.values()].sort((left, right) => compare(left.from, right.from) || compare(left.to, right.to) || compare(left.crossing, right.crossing))
}

function defaultOpen(contours: MapContour[]): string[] {
  const bySize = [...contours].sort((left, right) => right.components.reduce((total, entry) => total + entry.files.length, 0) - left.components.reduce((total, entry) => total + entry.files.length, 0) || compare(left.id, right.id))
  let visible = contours.length
  const open: string[] = []
  for (const contour of bySize) {
    if (contour.components.length < 2 || visible - 1 + contour.components.length > MAX_DEFAULT_NODES)
      continue
    visible += contour.components.length - 1
    open.push(contour.id)
  }
  return open.sort(compare)
}

function declaredContours(mechanics: MapMechanics, projectName: string): Contour[] {
  return mechanics.contours.length > 0 ? mechanics.contours : [{ id: ROOT_CONTOUR, name: projectName, kind: 'package', declaredBy: 'git ls-files -z', entries: [] }]
}

export function componentMap(mechanics: MapMechanics, interpreted: readonly InterpretedComponent[], projectName: string): ComponentMap {
  const contours = declaredContours(mechanics, projectName)
  const owner = (file: string): string => contourOf(file, contours)
  const read = new Map(mechanics.components.map(entry => [entry.path, { path: entry.path, state: entry.relations === 'found' ? 'held' as const : 'unknown' as const, reason: entry.relations === 'found' ? null : entry.reason }]))
  const filesOf = new Map<string, string[]>(contours.map(contour => [contour.id, []]))
  for (const entry of mechanics.components)
    filesOf.get(owner(entry.path))?.push(entry.path)
  const mapContours: MapContour[] = contours.map((contour) => {
    const components = componentsOf(contour, interpreted, filesOf, read)
    const counts = sum(components.map(entry => entry.counts))
    return { id: contourNode(contour.id), name: contour.name, kind: contour.kind, declaredBy: contour.declaredBy, entries: contour.entries, components, state: stateOf(counts), counts }
  })
  const componentOfFile = new Map<string, string>()
  for (const contour of mapContours) {
    for (const entry of contour.components) {
      for (const file of entry.files) {
        if (file.state !== 'absent')
          componentOfFile.set(file.path, entry.id)
      }
    }
  }
  const entries = new Map(contours.map(contour => [contour.id, new Set(contour.entries)]))
  const relations: MapRelation[] = mechanics.relations
    .filter((relation): relation is Relation & { to: string } => relation.status === 'found' && relation.to != null)
    .map(relation => ({ from: relation.from, to: relation.to, at: `${relation.source.path}:${relation.source.line}`, crossing: crossingOf(relation, owner, entries) }))
  return { contours: mapContours, relations, arrows: arrowsOf(relations, owner, componentOfFile), open: defaultOpen(mapContours) }
}

export function visibleNodes(map: ComponentMap, open: readonly string[] = map.open): string[] {
  const opened = new Set(open)
  return map.contours.flatMap(contour => opened.has(contour.id) ? contour.components.map(entry => entry.id) : [contour.id])
}

export function visibleArrows(map: ComponentMap, open: readonly string[] = map.open): MapArrow[] {
  const visible = new Set(visibleNodes(map, open))
  return map.arrows.filter(arrow => visible.has(arrow.from) && visible.has(arrow.to))
}

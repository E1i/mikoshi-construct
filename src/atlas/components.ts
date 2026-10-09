import type { ComponentReason, Contour, ContourKind, InterpretedComponent, Mechanics, Relation } from '../model/schema.js'
import path from 'node:path'
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

export interface MapGroup {
  id: string
  name: string
  contours: string[]
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
  groups: MapGroup[]
  contours: MapContour[]
  relations: MapRelation[]
  arrows: MapArrow[]
  open: string[]
}

function contourNode(id: string): string {
  return `c:${id}`
}

function groupNode(parent: string): string {
  return `g:${parent}`
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

function sharedPrefix(left: string[], right: string[]): number {
  let shared = 0
  while (shared < left.length && shared < right.length && left[shared] === right[shared])
    shared += 1
  return shared
}

function arrowsOf(relations: MapRelation[], chainOf: (file: string) => string[]): MapArrow[] {
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
    const fromChain = chainOf(relation.from)
    const toChain = chainOf(relation.to)
    const shared = sharedPrefix(fromChain, toChain)
    for (const from of fromChain.slice(shared)) {
      for (const to of toChain.slice(shared))
        add(from, to, relation)
    }
  }
  return [...arrows.values()].sort((left, right) => compare(left.from, right.from) || compare(left.to, right.to) || compare(left.crossing, right.crossing))
}

function filesIn(contour: MapContour): number {
  return contour.components.reduce((total, entry) => total + entry.files.length, 0)
}

function groupsOf(contours: MapContour[]): MapGroup[] {
  if (contours.length <= MAX_DEFAULT_NODES)
    return []
  const byParent = new Map<string, MapContour[]>()
  for (const contour of contours) {
    const id = contour.id.slice(contourNode('').length)
    if (id === ROOT_CONTOUR)
      continue
    const parent = path.posix.dirname(id)
    byParent.set(parent, [...byParent.get(parent) ?? [], contour])
  }
  return [...byParent.entries()].filter(([, members]) => members.length > 1).map(([parent, members]) => {
    const counts = sum(members.map(member => member.counts))
    return { id: groupNode(parent), name: parent === ROOT_CONTOUR ? '*' : `${parent}/*`, contours: members.map(member => member.id), state: stateOf(counts), counts }
  }).sort((left, right) => compare(left.id, right.id))
}

function defaultOpen(groups: MapGroup[], contours: MapContour[]): string[] {
  const groupOf = new Map(groups.flatMap(group => group.contours.map(contour => [contour, group.id] as const)))
  const byId = new Map(contours.map(contour => [contour.id, contour]))
  const size = (group: MapGroup): number => group.contours.reduce((total, id) => total + filesIn(byId.get(id)!), 0)
  let visible = groups.length + contours.filter(contour => !groupOf.has(contour.id)).length
  const open: string[] = []
  const unfold = (id: string, members: number): void => {
    if (members < 2 || visible - 1 + members > MAX_DEFAULT_NODES)
      return
    visible += members - 1
    open.push(id)
  }
  for (const group of [...groups].sort((left, right) => size(right) - size(left) || compare(left.id, right.id)))
    unfold(group.id, group.contours.length)
  const shown = contours.filter(contour => !groupOf.has(contour.id) || open.includes(groupOf.get(contour.id)!))
  for (const contour of shown.sort((left, right) => filesIn(right) - filesIn(left) || compare(left.id, right.id)))
    unfold(contour.id, contour.components.length)
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
  const groups = groupsOf(mapContours)
  const groupOfContour = new Map(groups.flatMap(group => group.contours.map(contour => [contour, group.id] as const)))
  const componentOfFile = new Map<string, string>()
  for (const contour of mapContours) {
    for (const entry of contour.components) {
      for (const file of entry.files) {
        if (file.state !== 'absent')
          componentOfFile.set(file.path, entry.id)
      }
    }
  }
  const chainOf = (file: string): string[] => {
    const contour = contourNode(owner(file))
    const group = groupOfContour.get(contour)
    const component = componentOfFile.get(file)
    return [...group === undefined ? [] : [group], contour, ...component === undefined ? [] : [component]]
  }
  const entries = new Map(contours.map(contour => [contour.id, new Set(contour.entries)]))
  const relations: MapRelation[] = mechanics.relations
    .filter((relation): relation is Relation & { to: string } => relation.status === 'found' && relation.to != null)
    .map(relation => ({ from: relation.from, to: relation.to, at: `${relation.source.path}:${relation.source.line}`, crossing: crossingOf(relation, owner, entries) }))
  return { groups, contours: mapContours, relations, arrows: arrowsOf(relations, chainOf), open: defaultOpen(groups, mapContours) }
}

export function visibleNodes(map: ComponentMap, open: readonly string[] = map.open): string[] {
  const opened = new Set(open)
  const groupOf = new Map(map.groups.flatMap(group => group.contours.map(contour => [contour, group.id] as const)))
  const shownGroups = new Set<string>()
  return map.contours.flatMap((contour) => {
    const group = groupOf.get(contour.id)
    if (group !== undefined && !opened.has(group)) {
      if (shownGroups.has(group))
        return []
      shownGroups.add(group)
      return [group]
    }
    return opened.has(contour.id) ? contour.components.map(entry => entry.id) : [contour.id]
  })
}

export function visibleArrows(map: ComponentMap, open: readonly string[] = map.open): MapArrow[] {
  const visible = new Set(visibleNodes(map, open))
  return map.arrows.filter(arrow => visible.has(arrow.from) && visible.has(arrow.to))
}

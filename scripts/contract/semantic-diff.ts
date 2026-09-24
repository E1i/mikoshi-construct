import type { JsonSample } from './json-samples.js'
import type { CommandSurface, Flag, Surface } from './surface.js'

export const UNBASELINED = 'unbaselined'

export const SECTIONS = ['commands', 'exits', 'jsonKeys', 'formats', 'paths', 'markers', 'outside'] as const

export type Section = typeof SECTIONS[number]

export type SurfaceReading = { [K in Section]: Surface[K] | typeof UNBASELINED }

export type ChangeLevel = 'none' | 'additive' | 'breaking'

export interface RequiredChange {
  level: ChangeLevel
  reasons: string[]
}

interface Change {
  breaking: boolean
  reason: string
}

type Compare<T> = (at: string, base: T, head: T) => Change[]

function breaking(reason: string): Change {
  return { breaking: true, reason }
}

function additive(reason: string): Change {
  return { breaking: false, reason }
}

function shown(value: unknown): string {
  return value === undefined ? 'none' : String(value)
}

function valueDiff(at: string, base: unknown, head: unknown): Change[] {
  return base === head ? [] : [breaking(`${at}: ${shown(base)} → ${shown(head)}`)]
}

function setDiff(at: string, base: string[], head: string[]): Change[] {
  const before = new Set(base)
  const after = new Set(head)
  return [
    ...base.filter(item => !after.has(item)).map(item => breaking(`${at}: ${item} removed`)),
    ...head.filter(item => !before.has(item)).map(item => additive(`${at}: ${item} added`)),
  ]
}

function recordDiff<T>(at: string, base: Record<string, T>, head: Record<string, T>, compare: Compare<T>): Change[] {
  return [
    ...Object.keys(base).flatMap(key => key in head ? compare(`${at}.${key}`, base[key], head[key]) : [breaking(`${at}.${key} removed`)]),
    ...Object.keys(head).filter(key => !(key in base)).map(key => additive(`${at}.${key} added`)),
  ]
}

function aliasDiff(at: string, base: string | undefined, head: string | undefined): Change[] {
  if (base === head)
    return []
  if (base === undefined)
    return [additive(`${at}: ${head} added`)]
  if (head === undefined)
    return [breaking(`${at}: ${base} removed`)]
  return valueDiff(at, base, head)
}

function flagDiff(at: string, base: Flag, head: Flag): Change[] {
  return [...valueDiff(`${at}.type`, base.type, head.type), ...aliasDiff(`${at}.alias`, base.alias, head.alias)]
}

function outsideDiff(at: string, base: string[], head: string[]): Change[] {
  const before = new Set(base)
  const after = new Set(head)
  return [
    ...head.filter(item => !before.has(item)).map(item => breaking(`${at}: ${item} added, so it leaves the contract`)),
    ...base.filter(item => !after.has(item)).map(item => additive(`${at}: ${item} removed, so it enters the contract`)),
  ]
}

function commandDiff(at: string, base: CommandSurface, head: CommandSurface): Change[] {
  if ('aliasOf' in base)
    return 'aliasOf' in head ? valueDiff(`${at}.aliasOf`, base.aliasOf, head.aliasOf) : [breaking(`${at}: alias of ${base.aliasOf} → a command of its own`)]
  if ('aliasOf' in head)
    return [breaking(`${at}: a command of its own → alias of ${head.aliasOf}`)]
  return recordDiff(`${at}.flags`, base.flags, head.flags, flagDiff)
}

function exitTableDiff(at: string, base: Record<string, number>, head: Record<string, number>): Change[] {
  return recordDiff(at, base, head, valueDiff)
}

function sampleDiff(at: string, base: JsonSample, head: JsonSample): Change[] {
  return [...valueDiff(`${at}.root`, base.root, head.root), ...setDiff(`${at}.keys`, base.keys, head.keys)]
}

function blockPairs(markers: Surface['markers']): string[] {
  return markers.block.map(pair => pair.join(' … '))
}

const SECTION_DIFF: { [K in Section]: Compare<Surface[K]> } = {
  commands: (at, base, head) => recordDiff(at, base, head, commandDiff),
  exits: (at, base, head) => recordDiff(at, base, head, exitTableDiff),
  jsonKeys: (at, base, head) => recordDiff(at, base, head, (command, states, next) => recordDiff(command, states, next, sampleDiff)),
  formats: (at, base, head) => recordDiff<number>(at, { ...base }, { ...head }, valueDiff),
  paths: (at, base, head) => [
    ...recordDiff(`${at}.init`, base.init, head.init, setDiff),
    ...setDiff(`${at}.attach.writes`, base.attach.writes, head.attach.writes),
    ...setDiff(`${at}.attach.edits`, base.attach.edits, head.attach.edits),
  ],
  markers: (at, base, head) => [
    ...setDiff(`${at}.block`, blockPairs(base), blockPairs(head)),
    ...setDiff(`${at}.discover.tags`, base.discover.tags, head.discover.tags),
    ...setDiff(`${at}.discover.markers`, base.discover.markers, head.discover.markers),
  ],
  outside: outsideDiff,
}

function sectionDiff<K extends Section>(section: K, base: SurfaceReading, head: Surface): Change[] {
  const recorded = base[section]
  if (recorded === UNBASELINED)
    return [breaking(`${section}: unbaselined in the base, so every item in it counts as changed`)]
  return SECTION_DIFF[section](section, recorded as Surface[K], head[section])
}

export function requiredChange(base: SurfaceReading, head: Surface): RequiredChange {
  const changes = SECTIONS.flatMap(section => sectionDiff(section, base, head))
  const level: ChangeLevel = changes.some(change => change.breaking) ? 'breaking' : changes.length > 0 ? 'additive' : 'none'
  return { level, reasons: changes.map(change => change.reason) }
}

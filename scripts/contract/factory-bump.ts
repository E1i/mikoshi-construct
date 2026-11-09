import { isDeepStrictEqual } from 'node:util'
import { UNRECORDED_VERSION } from '../core/bus-version.js'

export const VERSIONED_SECTIONS = { bus: 'busVersion', card: 'cardVersion', ports: 'portsVersion', nodes: 'nodesVersion', laws: 'lawsVersion' } as const

export type VersionedSection = keyof typeof VERSIONED_SECTIONS

export interface SectionVerdict {
  section: VersionedSection
  red: boolean
  line: string
}

type Recorded = Record<string, unknown>

function recorded(value: unknown): Recorded | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Recorded : null
}

function versionOf(section: Recorded, key: string): number {
  const version = section[key]
  return typeof version === 'number' ? version : UNRECORDED_VERSION
}

function bodyOf(section: Recorded, key: string): Recorded {
  return Object.fromEntries(Object.entries(section).filter(([name]) => name !== key))
}

function changedEntries(base: Recorded, head: Recorded): string[] {
  return [...new Set([...Object.keys(base), ...Object.keys(head)])].sort().flatMap((name) => {
    if (isDeepStrictEqual(base[name], head[name]))
      return []
    const before = recorded(base[name])
    const after = recorded(head[name])
    if (before === null || after === null)
      return [name]
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(entry => !isDeepStrictEqual(before[entry], after[entry])).map(entry => `${name}.${entry}`)
  })
}

export function sectionVerdict(section: VersionedSection, baseSection: unknown, headSection: unknown): SectionVerdict {
  const key = VERSIONED_SECTIONS[section]
  const base = recorded(baseSection)
  const head = recorded(headSection)
  if (head === null) {
    return base === null
      ? { section, red: false, line: `${section}: absent from the base and the head` }
      : { section, red: true, line: `${section}: the base holds it and the head does not; a removed section is a change no version can record` }
  }
  const headVersion = versionOf(head, key)
  if (base === null)
    return { section, red: false, line: `${section}: new since the base, at ${key} ${headVersion}` }
  const baseVersion = versionOf(base, key)
  if (headVersion < baseVersion)
    return { section, red: true, line: `${section}: ${key} went down from ${baseVersion} to ${headVersion}` }
  const changed = changedEntries(bodyOf(base, key), bodyOf(head, key))
  if (changed.length === 0)
    return { section, red: false, line: `${section}: unchanged, ${key} ${headVersion}` }
  const entries = `changed (${changed.join(', ')})`
  if (headVersion > baseVersion)
    return { section, red: false, line: `${section}: ${entries}, ${key} grew from ${baseVersion} to ${headVersion}` }
  return { section, red: true, line: `${section}: ${entries} and ${key} stayed ${baseVersion}: grow it to ${baseVersion + 1} in the module that writes it and regenerate the record` }
}

export function factoryVerdicts(base: unknown, head: unknown): SectionVerdict[] {
  const before = recorded(base) ?? {}
  const after = recorded(head) ?? {}
  return (Object.keys(VERSIONED_SECTIONS) as VersionedSection[]).map(section => sectionVerdict(section, before[section], after[section]))
}

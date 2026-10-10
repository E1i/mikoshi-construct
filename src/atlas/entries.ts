import type { EntryKind } from '../model/entries/index.js'
import type { Relation } from '../model/schema.js'
import { entryKindOf } from '../model/entries/index.js'

export interface MapEntry {
  id: string
  kind: EntryKind
  name: string
  source: string
  at: string
  runs: string[]
}

export interface MapEntrySource {
  id: string
  path: string
  kind: EntryKind
  entries: string[]
}

export interface EntryMap {
  sources: MapEntrySource[]
  entries: MapEntry[]
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function entryNode(source: string, name: string): string {
  return `e:${source}#${name}`
}

export function entrySourceNode(source: string): string {
  return `s:${source}`
}

export function entryMap(relations: readonly Relation[]): EntryMap {
  const byEntry = new Map<string, MapEntry & { line: number }>()
  for (const relation of relations) {
    const kind = relation.kind === 'runs' ? entryKindOf(relation.from) : null
    if (kind == null)
      continue
    const id = entryNode(relation.from, relation.specifier)
    const entry = byEntry.get(id) ?? { id, kind, name: relation.specifier, source: relation.from, at: '', runs: [], line: relation.source.line }
    entry.line = Math.min(entry.line, relation.source.line)
    if (relation.to != null && !entry.runs.includes(relation.to))
      entry.runs.push(relation.to)
    byEntry.set(id, entry)
  }
  const entries = [...byEntry.values()]
    .sort((left, right) => compare(left.source, right.source) || left.line - right.line || compare(left.name, right.name))
    .map(({ line, ...entry }) => ({ ...entry, at: `${entry.source}:${line}`, runs: [...entry.runs].sort(compare) }))
  const sources = new Map<string, MapEntrySource>()
  for (const entry of entries) {
    const source = sources.get(entry.source) ?? { id: entrySourceNode(entry.source), path: entry.source, kind: entry.kind, entries: [] }
    source.entries.push(entry.id)
    sources.set(entry.source, source)
  }
  return { sources: [...sources.values()], entries }
}

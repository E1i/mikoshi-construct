import type { ReadFile } from '../imports/specifiers.js'
import type { Relation } from '../schema.js'
import type { EntryCommand } from './command.js'
import { targetsOf } from './command.js'
import { declaresHooks, settingsHooks } from './hooks.js'
import { declaresScripts, packageScripts } from './package-scripts.js'
import { declaresSteps, workflowSteps } from './workflow-steps.js'

export const ENTRY_KINDS = ['script', 'step', 'hook'] as const
export type EntryKind = (typeof ENTRY_KINDS)[number]

interface EntrySource {
  kind: EntryKind
  declares: (file: string) => boolean
  read: (file: string, text: string) => EntryCommand[]
}

const ENTRY_SOURCES: EntrySource[] = [
  { kind: 'script', declares: declaresScripts, read: packageScripts },
  { kind: 'step', declares: declaresSteps, read: workflowSteps },
  { kind: 'hook', declares: declaresHooks, read: settingsHooks },
]

export function entryKindOf(file: string): EntryKind | null {
  return ENTRY_SOURCES.find(source => source.declares(file))?.kind ?? null
}

function relationsOf(file: string, entries: EntryCommand[], tracked: Set<string>): Relation[] {
  return entries.flatMap(entry => targetsOf(entry, tracked).map((to): Relation => ({ from: file, to, kind: 'runs', specifier: entry.name, status: 'found', source: { path: file, line: entry.line } })))
}

export function discoverEntries(files: string[], read: ReadFile): Relation[] {
  const tracked = new Set(files)
  return files.flatMap((file) => {
    const source = ENTRY_SOURCES.find(candidate => candidate.declares(file))
    const text = source === undefined ? null : read(file)
    return source === undefined || text == null ? [] : relationsOf(file, source.read(file, text), tracked)
  })
}

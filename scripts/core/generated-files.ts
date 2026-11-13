import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface GeneratedFile {
  path: string
  rebuild: readonly string[] | null
  check: readonly string[] | null
  rebuiltOnUpdate: boolean
  seamSources: readonly string[] | null
  followSources: readonly string[] | null
}

export interface GeneratedRow extends GeneratedFile {
  id: string
  module: string
}

export const DECLARATIONS_FOLDER = 'declarations'
export const GENERATED_KIND = 'generated'
export const DECLARATION_SUFFIX = '.json'

const ROWS_IN_THE_SOURCE_TREE = path.join(import.meta.dirname, '..', '..', 'declarations', 'generated')
const ROWS_FROM_A_PACKAGE_ROOT = [DECLARATIONS_FOLDER, GENERATED_KIND]

const LIST_FIELDS = ['rebuild', 'check', 'seamSources', 'followSources'] as const

type ListField = typeof LIST_FIELDS[number]

const ROWS_THE_CODE_NAMES = {
  earlierCarriers: ['rebuild', 'check'],
  surface: ['rebuild', 'followSources'],
  factory: ['rebuild', 'followSources'],
  model: ['rebuild'],
  addPopulation: ['followSources'],
  selfHostingDrift: ['followSources'],
  knownViolations: ['rebuild', 'followSources'],
  moduleFiles: ['rebuild'],
} as const satisfies Record<string, readonly ListField[]>

export const SCRIPTS_THE_ROWS_RUN: readonly string[] = ['scripts/attach/earlier-carriers.ts']

const SCRIPT_ARGUMENT = /^(?:scripts|src)\/.+\.ts$/

type WithPresent<Field extends ListField> = GeneratedRow & { readonly [Name in Field]: NonNullable<GeneratedRow[Name]> }

type NamedRows = { readonly [Id in keyof typeof ROWS_THE_CODE_NAMES]: WithPresent<typeof ROWS_THE_CODE_NAMES[Id][number]> }

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry !== '')
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

export function rowProblems(key: string, value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return ['is not a JSON object']
  const row = value as Record<string, unknown>
  const problems: string[] = []
  if (row.id !== key)
    problems.push(`its key "${String(row.id)}" differs from its file name "${key}"`)
  for (const field of ['module', 'path'] as const) {
    if (!isText(row[field]))
      problems.push(`${field} is not a non-empty string`)
  }
  if (typeof row.rebuiltOnUpdate !== 'boolean')
    problems.push('rebuiltOnUpdate is not a boolean')
  for (const field of LIST_FIELDS) {
    if (row[field] !== null && !isTextList(row[field]))
      problems.push(`${field} is neither null nor a list of non-empty strings`)
  }
  if (row.rebuiltOnUpdate === true && row.rebuild === null)
    problems.push('rebuiltOnUpdate is true with no rebuild')
  return problems
}

export function readGeneratedRows(folder: string): GeneratedRow[] {
  return readdirSync(folder).filter(file => file.endsWith(DECLARATION_SUFFIX)).sort().map((file) => {
    const key = file.slice(0, -DECLARATION_SUFFIX.length)
    const value: unknown = JSON.parse(readFileSync(path.join(folder, file), 'utf8'))
    const problems = rowProblems(key, value)
    if (problems.length > 0)
      throw new Error(`${DECLARATIONS_FOLDER}/${GENERATED_KIND}/${file}: ${problems.join('; ')}`)
    return value as GeneratedRow
  })
}

export function rowsFolderAbove(start: string): string | null {
  let folder = start
  while (!existsSync(path.join(folder, ...ROWS_FROM_A_PACKAGE_ROOT))) {
    const parent = path.dirname(folder)
    if (parent === folder)
      return null
    folder = parent
  }
  return path.join(folder, ...ROWS_FROM_A_PACKAGE_ROOT)
}

function rowsFolder(): string {
  if (existsSync(ROWS_IN_THE_SOURCE_TREE))
    return ROWS_IN_THE_SOURCE_TREE
  const found = rowsFolderAbove(import.meta.dirname)
  if (found === null)
    throw new Error(`no ${DECLARATIONS_FOLDER}/${GENERATED_KIND}/ above ${import.meta.dirname}`)
  return found
}

export function namedRowProblems(rows: readonly GeneratedRow[]): string[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  const named = Object.entries(ROWS_THE_CODE_NAMES).flatMap(([id, fields]) => {
    const row = byId.get(id)
    if (row === undefined)
      return [`${DECLARATIONS_FOLDER}/${GENERATED_KIND}/ has no row ${id}, which the code names`]
    return fields.filter(field => row[field] === null).map(field => `${DECLARATIONS_FOLDER}/${GENERATED_KIND}/${id}${DECLARATION_SUFFIX}: ${field} is null, and the code reads it`)
  })
  const unpacked = rows.flatMap(row => [...(row.rebuild ?? []), ...(row.check ?? [])]
    .filter(argument => SCRIPT_ARGUMENT.test(argument) && !SCRIPTS_THE_ROWS_RUN.includes(argument))
    .map(script => `${DECLARATIONS_FOLDER}/${GENERATED_KIND}/${row.id}${DECLARATION_SUFFIX}: runs ${script}, which SCRIPTS_THE_ROWS_RUN does not name, so the factory build does not pack it`))
  return [...named, ...[...new Set(unpacked)]]
}

function namedRows(rows: readonly GeneratedRow[]): NamedRows {
  const problems = namedRowProblems(rows)
  if (problems.length > 0)
    throw new Error(problems.join('; '))
  return Object.fromEntries(rows.map(row => [row.id, row])) as unknown as NamedRows
}

const ROWS: readonly GeneratedRow[] = readGeneratedRows(rowsFolder())

export const GENERATED_FILES: NamedRows = namedRows(ROWS)

export const RATCHET_FILE = {
  path: 'contract/ratchet.json',
  rebuild: ['exec', 'tsx', 'scripts/contract/ratchet.ts'],
} as const

export const NAMED_BY_THEIR_READERS: readonly string[] = [GENERATED_FILES.knownViolations.path]

export const GENERATED_PATHS: readonly string[] = ROWS.map(row => row.path).filter(file => !NAMED_BY_THEIR_READERS.includes(file))

export const REBUILT_ON_UPDATE: readonly { path: string, rebuild: readonly string[] }[] = [
  ...ROWS.flatMap(row => row.rebuiltOnUpdate && row.rebuild !== null ? [{ path: row.path, rebuild: row.rebuild }] : []),
  RATCHET_FILE,
]

export const APPEND_ONLY_LOGS: readonly string[] = ['scripts/ci/sandbox-failing.jsonl']

export const SHARED_APPEND_PATHS: readonly string[] = [...REBUILT_ON_UPDATE.map(row => row.path), ...APPEND_ONLY_LOGS]

export const GENERATORS: readonly { path: string, command: string }[] = ROWS.flatMap(row => row.rebuild === null ? [] : [{ path: row.path, command: commandLine(row.rebuild) }])

export const REGENERATED: readonly { path: string, check: readonly string[] }[] = ROWS.flatMap(row => row.check === null ? [] : [{ path: row.path, check: row.check }])

export const SEAM_SOURCES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(ROWS.flatMap(row => row.seamSources === null ? [] : [[row.path, row.seamSources]]))

export function commandLine(args: readonly string[]): string {
  return `pnpm ${args.join(' ')}`
}

export function isRebuiltOnUpdate(file: string): boolean {
  return REBUILT_ON_UPDATE.some(row => row.path === file)
}

export function pathsRebuiltBy(rebuild: readonly string[]): string[] {
  return REBUILT_ON_UPDATE.filter(row => commandLine(row.rebuild) === commandLine(rebuild)).map(row => row.path)
}

export function rebuildsOf(files: readonly string[]): (readonly string[])[] {
  const selected = REBUILT_ON_UPDATE.filter(row => files.includes(row.path)).map(row => row.rebuild)
  return [...new Map(selected.map(rebuild => [commandLine(rebuild), rebuild])).values()]
}

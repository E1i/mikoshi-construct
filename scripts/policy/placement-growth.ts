export interface PlacementImport {
  from: string
  to: string
}

export interface PlacementModule {
  owns: readonly string[]
  contract: readonly string[]
  may_use: readonly string[]
  status: string
}

export interface PlacementGraph {
  modules: Readonly<Record<string, PlacementModule>>
  composition_roots: readonly string[]
  composition_imports: Readonly<Record<string, readonly string[]>>
  exclusions: Readonly<Record<string, readonly string[]>>
}

export interface GrownRow {
  row: string
  now: number
  after: number
  imports: PlacementImport[]
}

export const BOUNDARY_ROW_PREFIX = 'boundary:'

const COMPOSITION_ROOT = 'composition root'
const EXCLUSION = 'exclusion:'
const UNOWNED = 'unowned'
const CARVED_OUT = '!'
const ANY_DEPTH = '/**'
const TOOL = 'tool'
const UNDECIDED = 'undecided'
const DECIDED = 'decided'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isListRecord(value: unknown): value is Record<string, string[]> {
  return isRecord(value) && Object.values(value).every(isTextList)
}

function isModule(value: unknown): value is PlacementModule {
  return isRecord(value) && isTextList(value.owns) && isTextList(value.contract) && isTextList(value.may_use) && typeof value.status === 'string'
}

export function placementGraphOf(factoryText: string): PlacementGraph | null {
  let section: unknown
  try {
    section = (JSON.parse(factoryText) as { modules?: unknown } | null)?.modules
  }
  catch {
    return null
  }
  if (!isRecord(section) || !isRecord(section.modules) || !Object.values(section.modules).every(isModule))
    return null
  if (!isTextList(section.composition_roots) || !isListRecord(section.composition_imports) || !isListRecord(section.exclusions))
    return null
  return section as unknown as PlacementGraph
}

export function boundaryRowsOf(ratchetText: string): Record<string, number> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(ratchetText)
  }
  catch {
    return null
  }
  if (!isRecord(parsed))
    return null
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => entry[0].startsWith(BOUNDARY_ROW_PREFIX) && typeof entry[1] === 'number'))
}

function matchesGlob(glob: string, file: string): boolean {
  return glob.endsWith(ANY_DEPTH) ? file.startsWith(glob.slice(0, -ANY_DEPTH.length + 1)) : file === glob
}

function heldBy(globs: readonly string[], file: string): boolean {
  const carved = globs.filter(glob => glob.startsWith(CARVED_OUT)).map(glob => glob.slice(CARVED_OUT.length))
  return !carved.includes(file) && globs.some(glob => !glob.startsWith(CARVED_OUT) && matchesGlob(glob, file))
}

function holderOf(graph: PlacementGraph, file: string): string {
  const module = Object.entries(graph.modules).find(([, { owns }]) => heldBy(owns, file))?.[0]
  if (module !== undefined)
    return module
  if (heldBy(graph.composition_roots, file))
    return COMPOSITION_ROOT
  const exclusion = Object.entries(graph.exclusions).find(([, globs]) => heldBy(globs, file))?.[0]
  return exclusion === undefined ? UNOWNED : `${EXCLUSION}${exclusion}`
}

function isGraphModule(graph: PlacementGraph, holder: string): boolean {
  const module = graph.modules[holder]
  return module !== undefined && module.status !== TOOL
}

function violates(graph: PlacementGraph, fromModule: string, toHolder: string, { from, to }: PlacementImport): boolean {
  if (toHolder === COMPOSITION_ROOT)
    return graph.composition_imports[to]?.includes(from) !== true
  const target = graph.modules[toHolder]
  if (toHolder.startsWith(EXCLUSION) || target === undefined || target.status === TOOL)
    return true
  const source = graph.modules[fromModule]!
  const written = source.may_use.includes(toHolder)
  const intoContract = heldBy(target.contract, to)
  const intoDecidedContractItNames = target.status === DECIDED && written && intoContract
  return (source.status === UNDECIDED && !intoDecidedContractItNames) || target.status === UNDECIDED || !written || !intoContract
}

export function boundaryRowOf(graph: PlacementGraph, placed: PlacementImport): string | null {
  const fromModule = holderOf(graph, placed.from)
  const toHolder = holderOf(graph, placed.to)
  if (!isGraphModule(graph, fromModule) || fromModule === toHolder || !violates(graph, fromModule, toHolder, placed))
    return null
  return `${BOUNDARY_ROW_PREFIX}${fromModule}->${toHolder.replaceAll(' ', '-')}`
}

export function placementGrowth(imports: readonly PlacementImport[], graph: PlacementGraph, recorded: Readonly<Record<string, number>>): GrownRow[] {
  const byRow = new Map<string, PlacementImport[]>()
  for (const placed of imports) {
    const row = boundaryRowOf(graph, placed)
    if (row === null)
      continue
    const held = byRow.get(row) ?? []
    if (!held.some(other => other.from === placed.from && other.to === placed.to))
      byRow.set(row, [...held, placed])
  }
  return [...byRow].map(([row, placed]) => {
    const now = recorded[row] ?? 0
    return { row, now, after: now + placed.length, imports: placed }
  })
}

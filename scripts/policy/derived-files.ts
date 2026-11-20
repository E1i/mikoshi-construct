export interface DerivedRow {
  path: string
  rebuild: readonly string[] | null
  module: string
  measure?: boolean
}

export interface DerivedRegistry {
  rows: readonly DerivedRow[]
  moduleDeclarations: string
  declarationSuffix: string
  moduleFiles: string
}

export type DerivedRerun = { kind: 'ran', outputs: ReadonlyMap<string, string | null> } | { kind: 'failed', why: string }

export interface DerivedReading {
  current: (file: string) => string | null
  base: (file: string) => string | null
  rerun: (command: readonly string[], outputs: readonly string[]) => DerivedRerun
}

export interface RefusedDerived {
  file: string
  why: string
}

export interface GrownDerived {
  file: string
  entries: string[]
}

export interface DerivedVerdict {
  followed: string[]
  refused: RefusedDerived[]
  grown: GrownDerived[]
}

const FOLDER_SUFFIX = '/'
const DECISION = 'D-592'

export function rerunnable(row: DerivedRow): row is DerivedRow & { rebuild: readonly string[] } {
  return row.rebuild !== null && !row.path.endsWith(FOLDER_SUFFIX)
}

function rowOf(registry: DerivedRegistry, file: string): (DerivedRow & { rebuild: readonly string[] }) | undefined {
  return registry.rows.filter(rerunnable).find(row => row.path === file)
}

export function isDerived(registry: DerivedRegistry, file: string): boolean {
  return rowOf(registry, file) !== undefined
}

function commandText(args: readonly string[]): string {
  return `pnpm ${args.join(' ')}`
}

function parsedOrNull(text: string | null): unknown {
  if (text === null)
    return null
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return undefined
  }
}

function entryTexts(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map(entry => JSON.stringify(entry)) : null
}

export function removesEntriesOnly(before: string | null, after: string | null): boolean {
  const was = entryTexts(parsedOrNull(before))
  const is = entryTexts(parsedOrNull(after))
  if (was === null || is === null || is.length >= was.length)
    return false
  return unmatched(is, was).length === 0
}

function unmatched(entries: readonly string[], among: readonly string[]): string[] {
  const left = [...among]
  return entries.filter((entry) => {
    const at = left.indexOf(entry)
    if (at === -1)
      return true
    left.splice(at, 1)
    return false
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function grownRows(before: unknown, after: Record<string, unknown>): string[] {
  const was = isRecord(before) ? before : {}
  return Object.entries(after).flatMap(([row, now]) => {
    const held = was[row]
    if (held === undefined)
      return [`${row} (new: ${JSON.stringify(now)})`]
    return typeof now === 'number' && typeof held === 'number' && now > held ? [`${row} (${held} → ${now})`] : []
  })
}

export function grownEntries(before: string | null, after: string | null): string[] {
  const now = parsedOrNull(after)
  const was = parsedOrNull(before)
  const entries = entryTexts(now)
  if (entries !== null)
    return unmatched(entries, entryTexts(was) ?? [])
  return isRecord(now) ? grownRows(was, now) : []
}

function moduleFilesOf(text: string | null): Record<string, unknown> {
  const parsed = parsedOrNull(text)
  return isRecord(parsed) ? parsed : {}
}

export function newOutputProblem(registry: DerivedRegistry, row: DerivedRow, reading: DerivedReading): string | null {
  if (reading.current(`${registry.moduleDeclarations}/${row.module}${registry.declarationSuffix}`) === null)
    return `${row.path} is a new output, and its owner module ${row.module} has no declaration in ${registry.moduleDeclarations}/`
  const owned = moduleFilesOf(reading.current(registry.moduleFiles))[row.module]
  if (!Array.isArray(owned) || !owned.includes(row.path))
    return `${row.path} is a new output, and ${registry.moduleFiles} built from the declarations does not give it to its owner module ${row.module}`
  return null
}

function rerunsOf(registry: DerivedRegistry, files: readonly string[], reading: DerivedReading): Map<string, DerivedRerun> {
  const runs = new Map<string, DerivedRerun>()
  for (const file of files) {
    const command = rowOf(registry, file)!.rebuild
    const key = commandText(command)
    if (!runs.has(key))
      runs.set(key, reading.rerun(command, registry.rows.filter(rerunnable).filter(row => commandText(row.rebuild) === key).map(row => row.path)))
  }
  return runs
}

function refusalOf(registry: DerivedRegistry, file: string, rerun: DerivedRerun, reading: DerivedReading): string | null {
  const row = rowOf(registry, file)!
  const command = commandText(row.rebuild)
  if (rerun.kind === 'failed')
    return `${command} could not be rerun on the card's tree, so ${file} is not shown to be its output: ${rerun.why}`
  if (rerun.outputs.get(file) !== reading.current(file))
    return `${command} rerun on the card's tree does not reproduce ${file} as committed; a hand edit the rerun does not reproduce is refused (${DECISION})`
  return reading.base(file) === null ? newOutputProblem(registry, row, reading) : null
}

export function judgeDerived(registry: DerivedRegistry, files: readonly string[], reading: DerivedReading): DerivedVerdict {
  const derived = files.filter(file => isDerived(registry, file))
  const runs = rerunsOf(registry, derived, reading)
  const verdict: DerivedVerdict = { followed: [], refused: [], grown: [] }
  for (const file of derived) {
    const row = rowOf(registry, file)!
    const why = refusalOf(registry, file, runs.get(commandText(row.rebuild))!, reading)
    const entries = why === null && row.measure === true ? grownEntries(reading.base(file), reading.current(file)) : []
    if (why !== null)
      verdict.refused.push({ file, why })
    else if (entries.length > 0)
      verdict.grown.push({ file, entries })
    else
      verdict.followed.push(file)
  }
  return verdict
}

export interface OwnerAllowance {
  text: string
  cards: readonly number[]
  owner: boolean
}

const MEASURED_ROW = /^(.+) \((?:(-?\d+) → (-?\d+)|new: (-?\d+))\)$/
const ROW_CHARACTER = /[\w:/.\->]/
const ALLOWED_VALUE = /^(?=[\s(])\s*(?:\(\s*)?(?:new:\s*)?(?:-?\d+\s*(?:->|→)\s*)?(-?\d+)/

export interface AllowanceSource {
  inForce: () => readonly { words: string, cards: readonly number[], written: boolean }[]
}

export function cardAllowancesIn(decisions: AllowanceSource, cardId: number | null | undefined): string[] {
  return allowancesOf(decisions.inForce().map(decision => ({ text: decision.words, cards: decision.cards, owner: decision.written })), cardId)
}

export function allowancesOf(decisions: readonly OwnerAllowance[], cardId: number | null | undefined): string[] {
  if (cardId === null || cardId === undefined)
    return []
  return decisions.filter(decision => decision.owner && decision.cards.includes(cardId)).map(decision => decision.text)
}

function valuesAllowedFor(row: string, text: string): number[] {
  const values: number[] = []
  for (let at = text.indexOf(row); at !== -1; at = text.indexOf(row, at + 1)) {
    if (at > 0 && ROW_CHARACTER.test(text[at - 1]!))
      continue
    const value = ALLOWED_VALUE.exec(text.slice(at + row.length))?.[1]
    if (value !== undefined)
      values.push(Number(value))
  }
  return values
}

export function allowedEntry(entry: string, allowances: readonly string[]): boolean {
  const measured = MEASURED_ROW.exec(entry)
  if (measured === null)
    return allowances.some(text => text.includes(entry))
  const [, row, , grownTo, newAt] = measured as unknown as [string, string, string | undefined, string | undefined, string | undefined]
  const value = Number(grownTo ?? newAt)
  return allowances.some(text => valuesAllowedFor(row, text).some(allowed => value <= allowed))
}

export function unallowedGrowth(grown: readonly GrownDerived[], allowances: readonly string[]): GrownDerived[] {
  return grown.flatMap((each) => {
    const entries = each.entries.filter(entry => !allowedEntry(entry, allowances))
    return entries.length === 0 ? [] : [{ file: each.file, entries }]
  })
}

export function derivedGrowthLine(grown: readonly GrownDerived[]): string {
  return `the derived ${grown.map(each => `${each.file} grows by ${each.entries.join(', ')}`).join('; ')}; the rerun reproduces it, and growth is the owner's decision (${DECISION}), so it waits for the owner`
}

export function derivedRefusalLine(refused: readonly RefusedDerived[]): string {
  return refused.map(each => each.why).join('; ')
}

import { parseCreatesEntry } from '../../card/parking.js'

export interface UnclearField {
  field: string
  reason: string
}

export interface DraftCard {
  name: string
  kind: string
  milestone: string
  size: string
  contour?: string
  decision?: string
  branch?: string
  touches: string[]
  depends: string[]
  blocks: string[]
  who?: string
  continue?: string
  whole?: string
  item?: string
  number?: number
  creates: string[]
  task: string
  witnesses: string[]
  unclear: UnclearField[]
}

export interface DraftPlan {
  id: string
  title: string
  goal: string
  file: string
}

export type ParsedDraft = { kind: 'draft', cards: DraftCard[], plan?: DraftPlan } | { kind: 'refused', reasons: string[] }

export const WITNESS_KINDS = ['acceptance', 'invariant'] as const
export type WitnessKind = typeof WITNESS_KINDS[number]

const REQUIRED_TEXT = ['name', 'kind', 'milestone', 'size', 'task'] as const
const OPTIONAL_TEXT = ['contour', 'decision', 'branch', 'who', 'continue', 'whole', 'item'] as const
const REQUIRED_LISTS = ['touches'] as const
const OPTIONAL_LISTS = ['depends', 'blocks', 'creates'] as const
const KEYS: readonly string[] = [...REQUIRED_TEXT, ...OPTIONAL_TEXT, ...REQUIRED_LISTS, 'witnesses', ...OPTIONAL_LISTS, 'number', 'unclear']
const PLAN_KEYS = ['id', 'title', 'goal', 'file'] as const
const DRAFT_KEYS = ['cards', 'plan']
const WITNESS_KIND_FIELD = new RegExp(` · (${WITNESS_KINDS.join('|')})$`)
const WITNESS_ENTRY_KEYS = ['witness', 'kind']

export function withWitnessKind(witness: string, kind: WitnessKind): string {
  return `${witness.trim()} · ${kind}`
}

export function witnessKindField(witness: string): WitnessKind | undefined {
  return WITNESS_KIND_FIELD.exec(witness.trim())?.[1] as WitnessKind | undefined
}

export function withoutWitnessKind(witness: string): string {
  return witness.trim().replace(WITNESS_KIND_FIELD, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText)
}

function isUnclear(value: unknown): value is UnclearField {
  return isRecord(value) && isText(value.field) && isText(value.reason) && Object.keys(value).length === 2
}

function witnessOf(entry: unknown): string | null {
  if (isText(entry))
    return entry
  if (!isRecord(entry) || !isText(entry.witness) || !(WITNESS_KINDS as readonly unknown[]).includes(entry.kind) || Object.keys(entry).some(key => !WITNESS_ENTRY_KEYS.includes(key)))
    return null
  return withWitnessKind(entry.witness, entry.kind as WitnessKind)
}

function witnessesOf(value: unknown, at: string, reasons: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    reasons.push(`${at}: 'witnesses' is missing; it has no default, so the retelling has to state at least one`)
    return []
  }
  return value.flatMap((entry) => {
    const witness = witnessOf(entry)
    if (witness === null)
      reasons.push(`${at}: a witness is text or { "witness": <text>, "kind": ${WITNESS_KINDS.map(kind => `"${kind}"`).join(' | ')} }`)
    return witness === null ? [] : [witness]
  })
}

function draftCard(entry: unknown, at: string, reasons: string[]): DraftCard | null {
  if (!isRecord(entry)) {
    reasons.push(`${at} is not an object`)
    return null
  }
  const before = reasons.length
  for (const key of Object.keys(entry).filter(key => !KEYS.includes(key)))
    reasons.push(`${at}: unknown key '${key}'; the keys are ${KEYS.join(', ')}`)
  for (const key of REQUIRED_TEXT.filter(key => !isText(entry[key])))
    reasons.push(`${at}: '${key}' is missing; it has no default, so the retelling has to state it`)
  for (const key of OPTIONAL_TEXT.filter(key => entry[key] !== undefined && !isText(entry[key])))
    reasons.push(`${at}: '${key}' must be text when given`)
  for (const key of REQUIRED_LISTS.filter(key => !isTextList(entry[key]) || (entry[key] as string[]).length === 0))
    reasons.push(`${at}: '${key}' is missing; it has no default, so the retelling has to state at least one`)
  const witnesses = witnessesOf(entry.witnesses, at, reasons)
  for (const key of OPTIONAL_LISTS.filter(key => entry[key] !== undefined && !isTextList(entry[key])))
    reasons.push(`${at}: '${key}' must be a list of text when given`)
  if (entry.number !== undefined && !(Number.isInteger(entry.number) && (entry.number as number) > 0))
    reasons.push(`${at}: 'number' must be a positive integer when given`)
  if (isTextList(entry.creates)) {
    const touches = isTextList(entry.touches) ? entry.touches : []
    for (const parsed of entry.creates.map(parseCreatesEntry)) {
      if (parsed.kind === 'refused')
        reasons.push(`${at}: ${parsed.reason}`)
      else if (!touches.includes(parsed.path))
        reasons.push(`${at}: 'creates' entry '${parsed.path}' is not in 'touches'; a path the change creates is also one it touches`)
    }
  }
  if (entry.unclear !== undefined && !(Array.isArray(entry.unclear) && entry.unclear.every(isUnclear)))
    reasons.push(`${at}: 'unclear' must be a list of { field, reason }`)
  if (reasons.length > before)
    return null
  return {
    ...(entry as unknown as DraftCard),
    witnesses,
    depends: (entry.depends as string[] | undefined) ?? [],
    blocks: (entry.blocks as string[] | undefined) ?? [],
    creates: (entry.creates as string[] | undefined) ?? [],
    unclear: (entry.unclear as UnclearField[] | undefined) ?? [],
  }
}

function draftPlan(value: unknown, reasons: string[]): DraftPlan | undefined {
  if (value === undefined)
    return undefined
  if (!isRecord(value) || PLAN_KEYS.some(key => !isText(value[key])) || Object.keys(value).some(key => !(PLAN_KEYS as readonly string[]).includes(key))) {
    reasons.push(`'plan' is { ${PLAN_KEYS.map(key => `"${key}": <text>`).join(', ')} }, the file a path inside the repository`)
    return undefined
  }
  return value as unknown as DraftPlan
}

export function parseDraft(text: string): ParsedDraft {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch (error) {
    return { kind: 'refused', reasons: [`the draft is not JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!isRecord(raw) || !Array.isArray(raw.cards) || raw.cards.length === 0)
    return { kind: 'refused', reasons: ['the draft is { "cards": [ … ] } with at least one card'] }
  const reasons: string[] = []
  for (const key of Object.keys(raw).filter(key => !DRAFT_KEYS.includes(key)))
    reasons.push(`unknown key '${key}'; the draft keys are ${DRAFT_KEYS.join(', ')}`)
  const plan = draftPlan(raw.plan, reasons)
  const cards = raw.cards.map((entry, index) => draftCard(entry, `card ${index + 1}`, reasons))
  const names = cards.flatMap(card => (card === null ? [] : [card.name]))
  for (const name of new Set(names.filter((name, index) => names.indexOf(name) !== index)))
    reasons.push(`the name '${name}' is given to more than one card`)
  if (reasons.length > 0)
    return { kind: 'refused', reasons }
  return { kind: 'draft', cards: cards as DraftCard[], ...(plan === undefined ? {} : { plan }) }
}

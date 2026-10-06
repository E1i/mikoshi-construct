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
  number?: number
  creates: string[]
  task: string
  witnesses: string[]
  unclear: UnclearField[]
}

export type ParsedDraft = { kind: 'draft', cards: DraftCard[] } | { kind: 'refused', reasons: string[] }

const REQUIRED_TEXT = ['name', 'kind', 'milestone', 'size', 'task'] as const
const OPTIONAL_TEXT = ['contour', 'decision', 'branch', 'who', 'continue', 'whole'] as const
const REQUIRED_LISTS = ['touches', 'witnesses'] as const
const OPTIONAL_LISTS = ['depends', 'blocks', 'creates'] as const
const KEYS: readonly string[] = [...REQUIRED_TEXT, ...OPTIONAL_TEXT, ...REQUIRED_LISTS, ...OPTIONAL_LISTS, 'number', 'unclear']

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
  for (const key of OPTIONAL_LISTS.filter(key => entry[key] !== undefined && !isTextList(entry[key])))
    reasons.push(`${at}: '${key}' must be a list of text when given`)
  if (entry.number !== undefined && !(Number.isInteger(entry.number) && (entry.number as number) > 0))
    reasons.push(`${at}: 'number' must be a positive integer when given`)
  if (isTextList(entry.creates)) {
    const touches = isTextList(entry.touches) ? entry.touches : []
    for (const created of entry.creates.filter(created => !touches.includes(created)))
      reasons.push(`${at}: 'creates' entry '${created}' is not in 'touches'; a path the change creates is also one it touches`)
  }
  if (entry.unclear !== undefined && !(Array.isArray(entry.unclear) && entry.unclear.every(isUnclear)))
    reasons.push(`${at}: 'unclear' must be a list of { field, reason }`)
  if (reasons.length > before)
    return null
  return {
    ...(entry as unknown as DraftCard),
    depends: (entry.depends as string[] | undefined) ?? [],
    blocks: (entry.blocks as string[] | undefined) ?? [],
    creates: (entry.creates as string[] | undefined) ?? [],
    unclear: (entry.unclear as UnclearField[] | undefined) ?? [],
  }
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
  const cards = raw.cards.map((entry, index) => draftCard(entry, `card ${index + 1}`, reasons))
  const names = cards.flatMap(card => (card === null ? [] : [card.name]))
  for (const name of new Set(names.filter((name, index) => names.indexOf(name) !== index)))
    reasons.push(`the name '${name}' is given to more than one card`)
  return reasons.length > 0 ? { kind: 'refused', reasons } : { kind: 'draft', cards: cards as DraftCard[] }
}

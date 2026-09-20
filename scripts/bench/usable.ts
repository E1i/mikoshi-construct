export const REQUIREMENTS = {
  decisionCharacters: 200,
  entryCharacters: 30,
  pathCharacters: 7,
  entries: 2,
} as const

export interface Usability {
  usable: boolean
  shortfalls: string[]
}

interface Spec {
  decision?: unknown
  contractChanges?: unknown
  compositionChanges?: unknown
  constraints?: unknown
  acceptance?: unknown
  files?: unknown
}

function listOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value as string[] : null
}

function shortfallsOfList(field: string, value: unknown, minimumCharacters: number): string[] {
  const entries = listOf(value)
  if (entries == null)
    return [`${field} is not a list of strings`]
  const shortfalls = entries.length < REQUIREMENTS.entries
    ? [`${field} names ${entries.length} of ${REQUIREMENTS.entries} entries`]
    : []
  const shortest = Math.min(...entries.map(entry => entry.trim().length))
  return entries.length > 0 && shortest < minimumCharacters
    ? [...shortfalls, `the shortest entry of ${field} is ${shortest} characters, under ${minimumCharacters}`]
    : shortfalls
}

export function usability(value: unknown): Usability {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    return { usable: false, shortfalls: ['the design is not an object'] }

  const spec = value as Spec
  const decision = typeof spec.decision === 'string' ? spec.decision.trim() : ''
  const shortfalls = [
    ...(decision.length < REQUIREMENTS.decisionCharacters
      ? [`decision is ${decision.length} characters, under ${REQUIREMENTS.decisionCharacters}`]
      : []),
    ...shortfallsOfList('constraints', spec.constraints, REQUIREMENTS.entryCharacters),
    ...shortfallsOfList('acceptance', spec.acceptance, REQUIREMENTS.entryCharacters),
    ...shortfallsOfList('files', spec.files, REQUIREMENTS.pathCharacters),
  ]
  return { usable: shortfalls.length === 0, shortfalls }
}

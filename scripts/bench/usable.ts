export const REQUIREMENTS = {
  decisionCharacters: 200,
  constraintsCharacters: 200,
  acceptanceCharacters: 200,
  filesCharacters: 60,
  entries: 2,
} as const

export interface Usability {
  usable: boolean
  shortfalls: string[]
}

interface Spec {
  decision?: unknown
  constraints?: unknown
  acceptance?: unknown
  files?: unknown
}

function shortfallsOfList(field: string, value: unknown, minimumCharacters: number): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string'))
    return [`${field} is not a list of strings`]
  const entries = value as string[]
  const written = entries.reduce((total, entry) => total + entry.trim().length, 0)
  return [
    ...(entries.length < REQUIREMENTS.entries ? [`${field} names ${entries.length} of ${REQUIREMENTS.entries} entries`] : []),
    ...(written < minimumCharacters ? [`${field} carries ${written} characters in all, under ${minimumCharacters}`] : []),
  ]
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
    ...shortfallsOfList('constraints', spec.constraints, REQUIREMENTS.constraintsCharacters),
    ...shortfallsOfList('acceptance', spec.acceptance, REQUIREMENTS.acceptanceCharacters),
    ...shortfallsOfList('files', spec.files, REQUIREMENTS.filesCharacters),
  ]
  return { usable: shortfalls.length === 0, shortfalls }
}

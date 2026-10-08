import { Buffer } from 'node:buffer'

export const PREFIX = '[decisions] '
export const DECISIONS_IN_FORCE_LIMIT = 8000
export const DECISION_FORMAT = '- D-N · <date> — <decision> [· superseded-by D-M]'

const ITEM = /^\s*[-*+]\s(.*)$/
const NUMBERED = /^D-(\d+)\b(.*)$/
const SUPERSEDED = /\s*(?:·\s*)?superseded-by D-(\d+)\s*$/
const DATE_SEPARATOR = ' — '

export interface Decision {
  number: number
  line: number
  text: string
  body: string
  supersededBy: number | null
}

export interface Decisions {
  decisions: Decision[]
  unnumbered: number[]
}

function bodyOf(rest: string): string {
  const separator = rest.indexOf(DATE_SEPARATOR)
  return (separator < 0 ? rest : rest.slice(separator + DATE_SEPARATOR.length)).trim()
}

export function parseDecisions(text: string): Decisions {
  const decisions: Decision[] = []
  const unnumbered: number[] = []
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const item = ITEM.exec(raw)
    if (item === null)
      continue
    const numbered = NUMBERED.exec(item[1]!.trim())
    if (numbered === null) {
      unnumbered.push(index + 1)
      continue
    }
    const superseded = SUPERSEDED.exec(numbered[2]!)
    const rest = superseded === null ? numbered[2]! : numbered[2]!.slice(0, superseded.index)
    decisions.push({
      number: Number(numbered[1]),
      line: index + 1,
      text: raw.trim(),
      body: bodyOf(rest),
      supersededBy: superseded === null ? null : Number(superseded[1]),
    })
  }
  return { decisions, unnumbered }
}

export function inForce(decisions: readonly Decision[]): Decision[] {
  return decisions.filter(decision => decision.supersededBy === null)
}

export function inForceBytes(decisions: readonly Decision[]): number {
  return inForce(decisions).reduce((bytes, decision) => bytes + Buffer.byteLength(`${decision.text}\n`, 'utf8'), 0)
}

function unnumberedRefusals(lines: readonly number[]): string[] {
  return lines.map(line => `${PREFIX}line ${line}: a decision without D-N; every decision is ${DECISION_FORMAT}`)
}

function repeatedNumberRefusals(decisions: readonly Decision[]): string[] {
  const seen = new Map<number, number>()
  const refusals: string[] = []
  for (const decision of decisions) {
    const first = seen.get(decision.number)
    if (first === undefined)
      seen.set(decision.number, decision.line)
    else
      refusals.push(`${PREFIX}D-${decision.number}: on line ${first} and line ${decision.line}; a number names one decision`)
  }
  return refusals
}

function supersedingRefusals(decisions: readonly Decision[]): string[] {
  const numbers = new Set(decisions.map(decision => decision.number))
  return decisions.flatMap((decision) => {
    if (decision.supersededBy === null)
      return []
    if (decision.supersededBy === decision.number)
      return [`${PREFIX}D-${decision.number}: superseded-by itself`]
    return numbers.has(decision.supersededBy) ? [] : [`${PREFIX}D-${decision.number}: superseded-by D-${decision.supersededBy}, which is not in the file`]
  })
}

function duplicateInForceRefusals(decisions: readonly Decision[]): string[] {
  const seen = new Map<string, number>()
  const refusals: string[] = []
  for (const decision of inForce(decisions)) {
    const key = decision.body.toLowerCase().replace(/\s+/g, ' ')
    const first = seen.get(key)
    if (first === undefined)
      seen.set(key, decision.number)
    else
      refusals.push(`${PREFIX}D-${decision.number} repeats D-${first}, both in force; mark one superseded-by the other`)
  }
  return refusals
}

function sizeRefusals(decisions: readonly Decision[]): string[] {
  const bytes = inForceBytes(decisions)
  return bytes <= DECISIONS_IN_FORCE_LIMIT ? [] : [`${PREFIX}decisions in force: ${bytes} bytes over the limit of ${DECISIONS_IN_FORCE_LIMIT}; mark the replaced ones superseded-by D-M`]
}

export function decisionsRefusals(text: string): string[] {
  const { decisions, unnumbered } = parseDecisions(text)
  return [
    ...unnumberedRefusals(unnumbered),
    ...repeatedNumberRefusals(decisions),
    ...supersedingRefusals(decisions),
    ...duplicateInForceRefusals(decisions),
    ...sizeRefusals(decisions),
  ]
}

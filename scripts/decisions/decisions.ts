import { Buffer } from 'node:buffer'

export const PREFIX = '[decisions] '
export const DECISIONS_IN_FORCE_LIMIT = 8000
export const WRITER_MARKER = 'decisions:add'
export const DECISION_FORMAT = `- D-N · <date> — <decision> [· card #A #B] [· ${WRITER_MARKER}] [· superseded-by D-M]`
export const SPENDING_DECISION = 54

const FIELD_PATTERNS: Record<string, string> = {
  'D-N': 'D-(?<number>[1-9]\\d*)',
  'D-M': 'D-(?<supersededBy>[1-9]\\d*)',
  '<date>': '\\d{4}-\\d{2}-\\d{2}(?: ~\\d{2}:\\d{2}Z)?',
  '<decision>': '(?<body>\\S.*?)',
  '#A #B': '(?<cards>#[1-9]\\d*(?: #[1-9]\\d*)*)',
  [WRITER_MARKER]: `(?<written>${WRITER_MARKER})`,
}
const FIELD = new RegExp(`(${Object.keys(FIELD_PATTERNS).join('|')})`)
const OPTIONAL_TAIL = / \[([^\]]+)\]/g
const LIST_START = /^\s*(?:[-*+]|\d+[.)])\s|^\s*D-/
const NUMBER_ATTEMPT = /^\s*(?:[-*+]\s+)?D-/
const SUPERSEDED_MENTION = /superseded-by/i

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function patternOf(part: string): string {
  return part.split(FIELD).map((piece, index) => index % 2 === 1 ? FIELD_PATTERNS[piece]! : escapeRegExp(piece)).join('')
}

function lineShape(format: string): RegExp {
  const optionals = [...format.matchAll(OPTIONAL_TAIL)]
  const required = optionals.length === 0 ? format : format.slice(0, optionals[0]!.index)
  const tails = optionals.map(optional => `(?: ${patternOf(optional[1]!)})?`).join('')
  return new RegExp(`^${patternOf(required)}${tails}$`)
}

const DECISION_LINE = lineShape(DECISION_FORMAT)

export interface Decision {
  number: number
  line: number
  text: string
  body: string
  cards: number[]
  written: boolean
  supersededBy: number | null
}

export interface OffFormatLine {
  line: number
  numbered: boolean
}

export interface Decisions {
  decisions: Decision[]
  offFormat: OffFormatLine[]
}

function decisionOf(text: string, line: number): Decision | null {
  const groups = DECISION_LINE.exec(text)?.groups
  if (groups === undefined || SUPERSEDED_MENTION.test(groups.body!))
    return null
  return {
    number: Number(groups.number),
    line,
    text,
    body: groups.body!,
    cards: groups.cards === undefined ? [] : groups.cards.split(' ').map(card => Number(card.slice(1))),
    written: groups.written !== undefined,
    supersededBy: groups.supersededBy === undefined ? null : Number(groups.supersededBy),
  }
}

export function parseDecisions(text: string): Decisions {
  const decisions: Decision[] = []
  const offFormat: OffFormatLine[] = []
  let listStarted = false
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    listStarted ||= LIST_START.test(raw)
    if (!listStarted || raw.trim() === '')
      continue
    const decision = decisionOf(raw.trim(), index + 1)
    if (decision === null)
      offFormat.push({ line: index + 1, numbered: NUMBER_ATTEMPT.test(raw) })
    else
      decisions.push(decision)
  }
  return { decisions, offFormat }
}

export function inForce(decisions: readonly Decision[]): Decision[] {
  return decisions.filter(decision => decision.supersededBy === null)
}

export function inForceBytes(decisions: readonly Decision[]): number {
  return inForce(decisions).reduce((bytes, decision) => bytes + Buffer.byteLength(`${decision.text}\n`, 'utf8'), 0)
}

export function spendDecisions(text: string, settled: (card: number) => boolean): string {
  const { decisions } = parseDecisions(text)
  if (!decisions.some(decision => decision.number === SPENDING_DECISION))
    return text
  const spent = new Set(inForce(decisions)
    .filter(decision => decision.cards.length > 0 && decision.cards.every(settled))
    .map(decision => decision.line))
  if (spent.size === 0)
    return text
  return text.split('\n').map((raw, index) => spent.has(index + 1) ? `${raw.trimEnd()} · superseded-by D-${SPENDING_DECISION}` : raw).join('\n')
}

function offFormatRefusals(lines: readonly OffFormatLine[]): string[] {
  return lines.map(({ line, numbered }) => `${PREFIX}line ${line}: ${numbered ? 'a decision off the format' : 'a decision without D-N'}; every decision is ${DECISION_FORMAT}`)
}

function repeatedNumberRefusals(decisions: readonly Decision[], archived: ReadonlySet<number>): string[] {
  const seen = new Map<number, number>()
  const refusals: string[] = []
  for (const decision of decisions) {
    const first = seen.get(decision.number)
    if (archived.has(decision.number))
      refusals.push(`${PREFIX}D-${decision.number}: on line ${decision.line} and in the archive; a number names one decision`)
    else if (first === undefined)
      seen.set(decision.number, decision.line)
    else
      refusals.push(`${PREFIX}D-${decision.number}: on line ${first} and line ${decision.line}; a number names one decision`)
  }
  return refusals
}

function nextUnarchived(previous: number, archived: ReadonlySet<number>): number {
  let next = previous + 1
  while (archived.has(next))
    next += 1
  return next
}

function orderRefusals(decisions: readonly Decision[], archived: ReadonlySet<number>): string[] {
  const seen = new Set<number>()
  const refusals: string[] = []
  let previous = 0
  for (const decision of decisions) {
    if (seen.has(decision.number) || archived.has(decision.number))
      continue
    seen.add(decision.number)
    const expected = nextUnarchived(previous, archived)
    if (decision.number !== expected)
      refusals.push(`${PREFIX}D-${decision.number} on line ${decision.line}: expected D-${expected}; numbers run 1..n in file order`)
    previous = decision.number
  }
  return refusals
}

function unmarkedRefusals(decisions: readonly Decision[]): string[] {
  const firstWritten = decisions.find(decision => decision.written)
  if (firstWritten === undefined)
    return []
  return decisions
    .filter(decision => decision.line > firstWritten.line && !decision.written)
    .map(decision => `${PREFIX}D-${decision.number} on line ${decision.line}: no ${WRITER_MARKER} marker after D-${firstWritten.number}, which has one; append a decision with pnpm ${WRITER_MARKER}`)
}

function supersedingRefusals(decisions: readonly Decision[], archived: ReadonlySet<number>): string[] {
  const numbers = new Set([...decisions.map(decision => decision.number), ...archived])
  return decisions.flatMap((decision) => {
    if (decision.supersededBy === null)
      return []
    if (decision.supersededBy === decision.number)
      return [`${PREFIX}D-${decision.number}: superseded-by itself`]
    if (decision.supersededBy < decision.number && decision.supersededBy !== SPENDING_DECISION)
      return [`${PREFIX}D-${decision.number}: superseded-by D-${decision.supersededBy}, an earlier number; the replacement takes a new, later number`]
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

export function decisionsRefusals(text: string, archive = ''): string[] {
  const { decisions, offFormat } = parseDecisions(text)
  const archived = new Set(parseDecisions(archive).decisions.map(decision => decision.number))
  return [
    ...offFormatRefusals(offFormat),
    ...repeatedNumberRefusals(decisions, archived),
    ...orderRefusals(decisions, archived),
    ...unmarkedRefusals(decisions),
    ...supersedingRefusals(decisions, archived),
    ...duplicateInForceRefusals(decisions),
    ...sizeRefusals(decisions),
  ]
}

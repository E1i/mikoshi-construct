export const PREFIX = '[decisions] '
export const WRITER_MARKER = 'decisions:add'
export const OWNER_SOURCE = '[owner]'
export const DECISION_FORMAT = `- D-N · <date> — <decision> [· supersedes D-K D-L] [· card #A #B] [· until <YYYY-MM-DDTHH:MMZ>] [· ${WRITER_MARKER}] [· superseded-by D-M]`
export const SPENT_MARK_OF_THE_OLD_FILES = 54
export const NEW_FILE_HEADER = `# Owner decisions\n\nA projection of the decisions table in the bus, rebuilt by the bus. Add a decision with pnpm ${WRITER_MARKER}.\n`

const TERM = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?Z'
const FIELD_PATTERNS: Record<string, string> = {
  'D-N': 'D-(?<number>[1-9]\\d*)',
  'D-M': 'D-(?<supersededBy>[1-9]\\d*)',
  '<date>': '\\d{4}-\\d{2}-\\d{2}(?: ~\\d{2}:\\d{2}Z)?',
  '<decision>': '(?<body>\\S.*?)',
  '#A #B': '(?<cards>#[1-9]\\d*(?: #[1-9]\\d*)*)',
  '<YYYY-MM-DDTHH:MMZ>': `(?<until>${TERM})`,
  [WRITER_MARKER]: `(?<written>${WRITER_MARKER})`,
  'D-K D-L': '(?<supersedes>D-[1-9]\\d*(?: D-[1-9]\\d*)*)',
}
const FIELD = new RegExp(`(${Object.keys(FIELD_PATTERNS).join('|')})`)
const OPTIONAL_TAIL = / \[([^\]]+)\]/g
const LIST_START = /^\s*(?:[-*+]|\d+[.)])\s|^\s*D-/
const NUMBER_ATTEMPT = /^\s*(?:[-*+]\s+)?D-/
const SUPERSEDING_MENTION = /superseded-by|\bsupersedes D-\d/i
const TAIL_IN_BODY = new RegExp(`· (?:${WRITER_MARKER}\\b|card #)`)
const TRAILING_UNTIL = new RegExp(`\\s(?:· )?until (?<until>${TERM})$`)
const UNTIL_ATTEMPT = /\buntil\W*\d{4}-\d{2}-\d{2}/i
const CARD_MENTION = /(?<!PR )#[1-9]\d*/

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

export interface Term {
  until: string | null
  unread: boolean
}

export interface Decision {
  number: number
  line: number
  text: string
  body: string
  cards: number[]
  term: Term
  written: boolean
  supersedes: number[]
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
  if (groups === undefined || SUPERSEDING_MENTION.test(groups.body!) || TAIL_IN_BODY.test(groups.body!))
    return null
  return {
    number: Number(groups.number),
    line,
    text,
    body: groups.body!,
    cards: groups.cards === undefined ? [] : groups.cards.split(' ').map(card => Number(card.slice(1))),
    term: termOf(groups.body!, groups.until),
    written: groups.written !== undefined,
    supersedes: groups.supersedes === undefined ? [] : groups.supersedes.split(' ').map(reference => Number(reference.slice(2))),
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

export function calendarTerm(until: string): boolean {
  const ms = Date.parse(until)
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(until.slice(0, -1))
}

export function termOf(body: string, tail?: string): Term {
  const trailing = TRAILING_UNTIL.exec(body)
  const rest = trailing === null ? body : body.slice(0, trailing.index)
  const terms = [tail, trailing?.groups?.until].filter(term => term !== undefined)
  const until = terms[0] ?? null
  return { until, unread: terms.length > 1 || UNTIL_ATTEMPT.test(rest) || (until !== null && !calendarTerm(until)) }
}

export function lapsed(term: Term, now: Date): boolean {
  return term.unread || (term.until !== null && Date.parse(term.until) <= now.getTime())
}

export function boundText(decision: Decision): string {
  return decision.term.until === null || TRAILING_UNTIL.test(decision.body) ? decision.body : `${decision.body} · until ${decision.term.until}`
}

export function inForce(decisions: readonly Decision[], now: Date = new Date()): Decision[] {
  const retired = new Set(decisions.flatMap(decision => decision.supersedes))
  return decisions.filter(decision => decision.supersededBy === null && !retired.has(decision.number) && !lapsed(decision.term, now))
}

export function spentByCards(decisions: readonly Decision[], settled: (card: number) => boolean): Decision[] {
  return inForce(decisions).filter(decision => decision.cards.length > 0 && decision.cards.every(settled))
}

export function visibleToCard(decision: { cards: readonly number[] }, card: number | null): boolean {
  return card === null || decision.cards.length === 0 || decision.cards.includes(card)
}

export function outOfForceLines(decisions: readonly Decision[], now: Date, settled: (card: number) => boolean): Set<number> {
  const termRan = decisions.filter(decision => decision.supersededBy === null && !decision.term.unread && lapsed(decision.term, now))
  return new Set([...termRan, ...spentByCards(decisions, settled)].map(decision => decision.line))
}

export function settleSupersedes(text: string, archive = ''): string {
  const { decisions } = parseDecisions(text)
  const retiredBy = new Map<number, number>()
  for (const decision of [...parseDecisions(archive).decisions, ...decisions]) {
    for (const target of decision.supersedes) {
      if (target < decision.number && !retiredBy.has(target))
        retiredBy.set(target, decision.number)
    }
  }
  return markSuperseded(text, new Map(decisions
    .filter(decision => decision.supersededBy === null && retiredBy.has(decision.number))
    .map(decision => [decision.line, retiredBy.get(decision.number)!])))
}

function markSuperseded(text: string, byLine: ReadonlyMap<number, number>): string {
  if (byLine.size === 0)
    return text
  return text.split('\n').map((raw, index) => {
    const replacement = byLine.get(index + 1)
    return replacement === undefined ? raw : `${raw.trimEnd()} · superseded-by D-${replacement}`
  }).join('\n')
}

function offFormatRefusals(lines: readonly OffFormatLine[]): string[] {
  return lines.map(({ line, numbered }) => `${PREFIX}line ${line}: ${numbered ? 'a decision off the format' : 'a decision without D-N'}; every decision is ${DECISION_FORMAT}`)
}

export function supersedingWayOut(number: number): string {
  return `pnpm ${WRITER_MARKER} --supersedes D-${number} "${OWNER_SOURCE} <what D-${number} says now>" retires every record of D-${number}`
}

function repeatedNumberRefusals(decisions: readonly Decision[], archived: ReadonlySet<number>): string[] {
  const seen = new Map<number, number>()
  const refusals: string[] = []
  for (const decision of decisions) {
    const first = seen.get(decision.number)
    if (archived.has(decision.number))
      refusals.push(`${PREFIX}D-${decision.number}: on line ${decision.line} and in the archive; a number names one decision; ${supersedingWayOut(decision.number)}`)
    else if (first === undefined)
      seen.set(decision.number, decision.line)
    else
      refusals.push(`${PREFIX}D-${decision.number}: on line ${first} and line ${decision.line}; a number names one decision; ${supersedingWayOut(decision.number)}`)
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
    if (decision.supersededBy < decision.number && decision.supersededBy !== SPENT_MARK_OF_THE_OLD_FILES)
      return [`${PREFIX}D-${decision.number}: superseded-by D-${decision.supersededBy}, an earlier number; the replacement takes a new, later number`]
    return numbers.has(decision.supersededBy) ? [] : [`${PREFIX}D-${decision.number}: superseded-by D-${decision.supersededBy}, which is not in the file`]
  })
}

function supersedesRefusals(decisions: readonly Decision[], archived: ReadonlySet<number>): string[] {
  const numbers = new Set([...decisions.map(decision => decision.number), ...archived])
  return decisions.flatMap(decision => decision.supersedes.flatMap((target) => {
    if (target === decision.number)
      return [`${PREFIX}D-${decision.number}: supersedes itself`]
    if (target > decision.number)
      return [`${PREFIX}D-${decision.number}: supersedes D-${target}, a later number; a decision retires only an earlier one`]
    return numbers.has(target) ? [] : [`${PREFIX}D-${decision.number}: supersedes D-${target}, which is not in the file`]
  }))
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

function untilRefusals(decisions: readonly Decision[]): string[] {
  return decisions
    .filter(decision => decision.term.unread)
    .map(decision => `${PREFIX}D-${decision.number} on line ${decision.line}: an until that does not read as · until <YYYY-MM-DDTHH:MMZ> at the end of the decision; it is not in force`)
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
    ...supersedesRefusals(decisions, archived),
    ...duplicateInForceRefusals(decisions),
    ...untilRefusals(decisions),
  ]
}

export function stampOf(now: Date): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 10)} ~${iso.slice(11, 16)}Z`
}

export function cardTail(cards: readonly number[]): string {
  return cards.length === 0 ? '' : ` · card ${[...new Set(cards)].map(card => `#${card}`).join(' ')}`
}

export function untilTail(until: string | null): string {
  return until === null ? '' : ` · until ${until}`
}

export interface DecisionRow {
  number: number
  text: string
  cards: number[]
  until: string | null
  inForce: boolean
  written: boolean
  recordedAt: string
  supersededBy: number | null
}

export interface ProjectedDecisions {
  file: string
  archive: string
}

function withoutSource(text: string): string {
  return text.startsWith(`${OWNER_SOURCE} `) ? text.slice(OWNER_SOURCE.length + 1) : text
}

function heldLineSays(held: Decision | undefined, row: DecisionRow): held is Decision {
  return held !== undefined
    && held.supersededBy === null
    && withoutSource(boundText(held)) === withoutSource(row.text)
    && JSON.stringify(held.cards) === JSON.stringify(row.cards)
}

function renderedLine(row: DecisionRow): string {
  const words = row.text.replace(TRAILING_UNTIL, '')
  const body = row.written ? `${OWNER_SOURCE} ${withoutSource(words)}` : words
  return `- D-${row.number} · ${stampOf(new Date(row.recordedAt))} — ${body}${cardTail(row.cards)}${untilTail(row.until)}${row.written ? ` · ${WRITER_MARKER}` : ''}`
}

function archivedLine(line: string, row: DecisionRow | undefined, marked: boolean): string {
  return marked || row === undefined || row.supersededBy === null ? line : `${line} · superseded-by D-${row.supersededBy}`
}

function preambleOf(text: string): string {
  const lines = text.split(/\r?\n/)
  const first = lines.findIndex(line => LIST_START.test(line))
  const preamble = (first === -1 ? lines : lines.slice(0, first)).join('\n').trimEnd()
  return preamble === '' ? NEW_FILE_HEADER : `${preamble}\n`
}

export function projectDecisions(rows: readonly DecisionRow[], file: string, archive: string, archiveHeader: string): ProjectedDecisions {
  const projected = projectionOf(rows, file, archive, archiveHeader)
  return decisionsRefusals(projected.file, projected.archive).length === 0 ? projected : { file, archive }
}

function projectionOf(rows: readonly DecisionRow[], file: string, archive: string, archiveHeader: string): ProjectedDecisions {
  const { decisions: lines, offFormat } = parseDecisions(file)
  const fileLines = file.split(/\r?\n/)
  const held = new Map(lines.map(decision => [decision.number, decision]))
  const byNumber = new Map(rows.map(row => [row.number, row]))
  const inArchive = new Set(parseDecisions(archive).decisions.map(decision => decision.number))
  const archiveLines = new Set(archive.split('\n'))
  const inForceLines = rows.filter(row => row.inForce).sort((a, b) => a.number - b.number).map((row) => {
    const line = held.get(row.number)
    return heldLineSays(line, row) ? line.text : renderedLine(row)
  })
  const leavingTheFile = lines
    .filter(decision => byNumber.get(decision.number)?.inForce !== true && !inArchive.has(decision.number))
    .map(decision => archivedLine(decision.text, byNumber.get(decision.number), decision.supersededBy !== null))
  const neverInTheFile = rows
    .filter(row => !row.inForce && !held.has(row.number) && !inArchive.has(row.number))
    .map(row => archivedLine(renderedLine(row), row, false))
  const offFormatLines = offFormat.map(({ line }) => fileLines[line - 1]!.trim()).filter(line => !archiveLines.has(line))
  const moved = [...leavingTheFile, ...neverInTheFile, ...offFormatLines]
  return {
    file: `${preambleOf(file)}${inForceLines.length === 0 ? '' : `\n${inForceLines.join('\n')}\n`}`,
    archive: moved.length === 0 ? archive : `${archive === '' ? archiveHeader : archive.replace(/\n*$/, '\n')}${moved.join('\n')}\n`,
  }
}

export function decisionsFindings(text: string): string[] {
  return inForce(parseDecisions(text).decisions).flatMap((decision) => {
    const mention = CARD_MENTION.exec(decision.body)
    return decision.cards.length > 0 || mention === null ? [] : [`${PREFIX}D-${decision.number} on line ${decision.line}: names ${mention[0]} in its text without · card #N; a decision bound to a card carries the card tail, so it is spent when the card closes`]
  })
}

export function decisionCommand(words: string, cards: readonly number[] = []): string {
  return `pnpm decisions:add ${cards.map(card => `--card #${card} `).join('')}"${OWNER_SOURCE} ${words}"`
}

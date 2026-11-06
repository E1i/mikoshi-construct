import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readBodyCard, SIZES } from '../../src/card/grammar.js'
import { defaultBusPath } from '../core/bus-path.js'
import { BUSY_TIMEOUT_MS } from '../core/db.js'
import { CARD_ADMITTED, MERGE_DONE, REVIEW_RECORDED, SESSION_HEARTBEAT } from '../core/events.js'
import { openDatabase } from '../core/sqlite.js'

export const UNKNOWN_SIZE = 'unknown'
export const CATEGORIES = ['behaviour', 'touches', 'witnesses', 'mutations', 'form', 'unclassified'] as const
export const SIZE_ROWS = [...SIZES, UNKNOWN_SIZE] as const
export const COLUMNS = ['before', 'after'] as const
export const OUTSIDE_THE_TOUCHES = 'outside the touches'
const MECHANISM_OUTSIDE_FORM = /^\S+ is outside the touches of card #\d+/
const MAIN_ROLES = ['launch', 'answer', 'review', 'session']

export type Category = typeof CATEGORIES[number]
export type Column = typeof COLUMNS[number]
type SizeRow = typeof SIZE_ROWS[number]

const CODE_NAMES = /`[^`]*`|'[^' ]*'|\S*[/.]\w\S*/g

const FORMS: readonly (readonly [Category, RegExp])[] = [
  ['mutations', /\bsurviving mutations?\b|\bmutations? survives?\b|\bmutants? survives?\b|\bsurvived? (?:the |a )?mutation\b/i],
  ['witnesses', /\b(?:card|change|named?|first|second|third|fourth|fifth|every|each|\d+|two|three|four|five) witness(?:es)?\b|\bwitness(?:es)? (?:W?\d+|names?|does not|do not|is not|are not|test|line|field|proves?)\b|\bW\d+\b/i],
  ['form', /\bstale\b|\b(?:no|missing|the|a) changeset\b|\bcode matrix\b|\bcount line\b|\btitle reads\b|\btest title\b|\bcomments?\b|\bunrelated to\b|\bnot rendered\b|\bre-?render\b|\btypo\b/i],
  ['mutations', /\b(?:is|are) not (?:covered|tested|exercised|pinned)\b|\buntested\b|\bno test (?:covers?|exercises?|records?|pins?|asserts?|proves?|reaches?)\b/i],
  ['behaviour', /\bthe card (?:says|asks|requires|names)\b|\bdoes not implement\b|\b(?:not|half|only half) done\b|\b(?:treats?|returns?|throws?|crash(?:es)?|drops?|loses?|ignores?|refuses?|overwrites?|skips?|never|wrong|incorrect|regress(?:es|ion)?|breaks?|silently|bug|defect|still (?:takes|writes|reads|defines|uses))\b/i],
]

export function categoryOf(finding: string, survivingMutations: readonly string[] = []): Category {
  if (finding.includes(OUTSIDE_THE_TOUCHES))
    return 'touches'
  if (survivingMutations.includes(finding))
    return 'mutations'
  const said = finding.replaceAll(CODE_NAMES, ' ')
  return FORMS.find(([, form]) => form.test(said))?.[0] ?? 'unclassified'
}

export interface CardsRow {
  cards: number
  sessions: number
  tokens: number
}

export interface RoleRow {
  sessions: number
  tokens: number
}

export interface NoiseRow {
  rounds: number
  noise: number
  sameHead: number
  outsideOnly: number
  both: number
  sameHeadThenPass: number
  sameHeadBodyChanged: number
}

export interface SizeColumn {
  cards: CardsRow
  categories: Record<Category, number>
  roles: Record<string, RoleRow>
  sessionsOnce: number
  spentFalls: number
  noise: NoiseRow
}

export type CardMeasure = Record<Column, Record<SizeRow, SizeColumn>>

export interface ListedFinding {
  card: number
  pr: number | null
  column: Column
  text: string
}

export interface Window {
  before: string
  after: string
}

interface Merged {
  card: number
  size: SizeRow
  columns: Column[]
}

interface ReviewRow {
  id: number
  card: number
  pr: number | null
  head: string | null
  payload: string
}

interface Round {
  id: number
  card: number
  pr: number | null
  head: string | null
  verdict: unknown
  cardBody: unknown
  findings: string[]
  surviving: string[]
}

function emptyColumn(): SizeColumn {
  return {
    cards: { cards: 0, sessions: 0, tokens: 0 },
    categories: Object.fromEntries(CATEGORIES.map(category => [category, 0])) as Record<Category, number>,
    roles: {},
    sessionsOnce: 0,
    spentFalls: 0,
    noise: { rounds: 0, noise: 0, sameHead: 0, outsideOnly: 0, both: 0, sameHeadThenPass: 0, sameHeadBodyChanged: 0 },
  }
}

function emptyMeasure(): CardMeasure {
  const bySize = (): Record<SizeRow, SizeColumn> => Object.fromEntries(SIZE_ROWS.map(size => [size, emptyColumn()])) as Record<SizeRow, SizeColumn>
  return { before: bySize(), after: bySize() }
}

function sizesOfCards(db: DatabaseSync): Map<number, SizeRow> {
  const rows = db.prepare(`SELECT card_id AS card, json_extract(payload, '$.card') AS line, json_extract(payload, '$.text') AS text FROM events WHERE type = '${CARD_ADMITTED}' AND legacy = 0 AND card_id IS NOT NULL ORDER BY id`).all() as { card: number, line: unknown, text: unknown }[]
  const sizes = new Map<number, SizeRow>()
  for (const { card, line, text } of rows) {
    const size = sizeOfAdmission(line) ?? sizeOfAdmission(text)
    if (size !== null)
      sizes.set(Number(card), size)
  }
  return sizes
}

function sizeOfAdmission(field: unknown): SizeRow | null {
  const parsed = typeof field === 'string' ? readBodyCard(field) : null
  return parsed?.kind === 'card' ? parsed.card.size : null
}

function columnsOf(ts: string, window: Window): Column[] {
  return [...(ts < window.before ? ['before' as const] : []), ...(ts >= window.after ? ['after' as const] : [])]
}

function mergedCards(db: DatabaseSync, window: Window): Map<number, Merged> {
  const rows = db.prepare(`SELECT card_id AS card, max(ts) AS ts FROM events WHERE type = '${MERGE_DONE}' AND legacy = 0 AND card_id IS NOT NULL GROUP BY card_id`).all() as { card: number, ts: string }[]
  const sizes = sizesOfCards(db)
  return new Map(rows.flatMap(({ card, ts }): [number, Merged][] => {
    const id = Number(card)
    const columns = columnsOf(ts, window)
    return columns.length === 0 ? [] : [[id, { card: id, size: sizes.get(id) ?? UNKNOWN_SIZE, columns }]]
  }))
}

interface SessionTrace {
  sessions: Map<string, { last: number, top: number, falls: number, rises: Map<string, number>, steps: Set<string> }>
}

function heartbeatTraces(db: DatabaseSync, cards: ReadonlyMap<number, Merged>): Map<number, SessionTrace> {
  const rows = db.prepare(`SELECT card_id AS card, json_extract(payload, '$.session') AS session, json_extract(payload, '$.step') AS step, json_extract(payload, '$.spent') AS spent FROM events WHERE type = '${SESSION_HEARTBEAT}' AND legacy = 0 AND card_id IS NOT NULL ORDER BY id`).all() as { card: number, session: unknown, step: unknown, spent: unknown }[]
  const traces = new Map<number, SessionTrace>()
  for (const row of rows) {
    const card = Number(row.card)
    if (!cards.has(card) || typeof row.session !== 'string')
      continue
    const trace = traces.get(card) ?? { sessions: new Map() }
    traces.set(card, trace)
    const session = trace.sessions.get(row.session) ?? { last: 0, top: 0, falls: 0, rises: new Map(), steps: new Set() }
    trace.sessions.set(row.session, session)
    const step = typeof row.step === 'string' ? row.step : 'session'
    session.steps.add(step)
    if (typeof row.spent !== 'number')
      continue
    if (row.spent < session.top)
      session.falls += 1
    session.rises.set(step, (session.rises.get(step) ?? 0) + Math.max(0, row.spent - session.top))
    session.top = Math.max(session.top, row.spent)
    session.last = row.spent
  }
  return traces
}

function addTrace(column: SizeColumn, trace: SessionTrace | undefined): void {
  column.cards.cards += 1
  for (const session of trace?.sessions.values() ?? []) {
    column.cards.sessions += 1
    column.sessionsOnce += 1
    column.cards.tokens += session.last
    column.spentFalls += session.falls
    for (const step of session.steps) {
      const role = column.roles[step] ?? { sessions: 0, tokens: 0 }
      column.roles[step] = { sessions: role.sessions + 1, tokens: role.tokens + (session.rises.get(step) ?? 0) }
    }
  }
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function roundsOf(db: DatabaseSync): Round[] {
  const rows = db.prepare(`SELECT id, card_id AS card, pr, head, payload FROM events WHERE type = '${REVIEW_RECORDED}' AND legacy = 0 AND card_id IS NOT NULL ORDER BY id`).all() as unknown as ReviewRow[]
  return rows.map((row) => {
    const payload = JSON.parse(row.payload) as { verdict?: unknown, card_body?: unknown, findings?: unknown, survivingMutations?: unknown, surviving_mutations?: unknown }
    return { id: Number(row.id), card: Number(row.card), pr: row.pr, head: row.head, verdict: payload.verdict, cardBody: payload.card_body, findings: stringsOf(payload.findings), surviving: stringsOf(payload.survivingMutations ?? payload.surviving_mutations) }
  })
}

function nextRoundIndex(rounds: readonly Round[]): Map<number, Round> {
  const next = new Map<number, Round>()
  const latest = new Map<number, Round>()
  for (const round of [...rounds].reverse()) {
    if (round.pr === null)
      continue
    const following = latest.get(round.pr)
    if (following !== undefined)
      next.set(round.id, following)
    latest.set(round.pr, round)
  }
  return next
}

function addNoise(noise: NoiseRow, round: Round, next: Round | undefined): void {
  const sameHead = next !== undefined && round.head !== null && next.head === round.head
  const outsideOnly = round.findings.length > 0 && round.findings.every(finding => MECHANISM_OUTSIDE_FORM.test(finding))
  noise.rounds += 1
  noise.noise += sameHead || outsideOnly ? 1 : 0
  noise.sameHead += sameHead ? 1 : 0
  noise.outsideOnly += outsideOnly ? 1 : 0
  noise.both += sameHead && outsideOnly ? 1 : 0
  noise.sameHeadThenPass += sameHead && next.verdict === 'pass' ? 1 : 0
  noise.sameHeadBodyChanged += sameHead && next.cardBody !== round.cardBody ? 1 : 0
}

export function cardMeasure(db: DatabaseSync, window: Window): CardMeasure {
  const measure = emptyMeasure()
  const merged = mergedCards(db, window)
  const traces = heartbeatTraces(db, merged)
  for (const card of merged.values()) {
    for (const column of card.columns)
      addTrace(measure[column][card.size], traces.get(card.card))
  }
  const rounds = roundsOf(db)
  const next = nextRoundIndex(rounds)
  for (const round of rounds.filter(item => item.verdict === 'changes')) {
    const card = merged.get(round.card)
    for (const column of card?.columns ?? []) {
      const row = measure[column][card!.size]
      addNoise(row.noise, round, next.get(round.id))
      for (const finding of round.findings)
        row.categories[categoryOf(finding, round.surviving)] += 1
    }
  }
  return measure
}

export function findingsOf(db: DatabaseSync, window: Window, category: Category): ListedFinding[] {
  const merged = mergedCards(db, window)
  return roundsOf(db).filter(round => round.verdict === 'changes').flatMap((round) => {
    const card = merged.get(round.card)
    return (card?.columns ?? []).flatMap(column => round.findings.filter(finding => categoryOf(finding, round.surviving) === category).map(text => ({ card: round.card, pr: round.pr, column, text })))
  })
}

function table(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string[] {
  const cells = [headers, ...rows].map(row => row.map(String))
  const widths = headers.map((_, index) => Math.max(...cells.map(row => row[index]!.length)))
  return cells.map(row => row.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd())
}

function perUnit(value: number, units: number): string {
  return units === 0 ? '—' : String(Math.round((value * 10) / units) / 10)
}

function populated(column: Record<SizeRow, SizeColumn>): [SizeRow, SizeColumn][] {
  return SIZE_ROWS.map((size): [SizeRow, SizeColumn] => [size, column[size]]).filter(([, row]) => row.cards.cards > 0)
}

function cardsTable(column: Record<SizeRow, SizeColumn>): string[] {
  return table(['size', 'cards', 'sessions/card', 'tokens/card'], populated(column).map(([size, { cards }]) => [size, cards.cards, perUnit(cards.sessions, cards.cards), Math.round(cards.tokens / cards.cards)]))
}

function categoriesTable(column: Record<SizeRow, SizeColumn>): string[] {
  const rows = populated(column)
  const lines = table(['size', ...CATEGORIES, 'unclassified share'], rows.map(([size, row]) => {
    const total = CATEGORIES.reduce((sum, category) => sum + row.categories[category], 0)
    return [size, ...CATEGORIES.map(category => row.categories[category]), total === 0 ? '—' : `${Math.round((row.categories.unclassified / total) * 100)}%`]
  }))
  return lines
}

function rolesOfRow(row: SizeColumn): string[] {
  return [...new Set([...MAIN_ROLES, ...Object.keys(row.roles).sort()])]
}

function rolesTable(column: Record<SizeRow, SizeColumn>): string[] {
  return table(['size', 'role', 'sessions', 'tokens/session', 'tokens/card'], populated(column).flatMap(([size, row]) => [
    ...rolesOfRow(row).map((role) => {
      const { sessions, tokens } = row.roles[role] ?? { sessions: 0, tokens: 0 }
      return [size, role, sessions, sessions === 0 ? '—' : Math.round(tokens / sessions), Math.round(tokens / row.cards.cards)]
    }),
    [size, 'every session once', row.sessionsOnce, row.sessionsOnce === 0 ? '—' : Math.round(row.cards.tokens / row.sessionsOnce), Math.round(row.cards.tokens / row.cards.cards)],
  ]))
}

function noiseTable(column: Record<SizeRow, SizeColumn>): string[] {
  return table(['size', 'rounds', 'noise', 'same head', 'only outside the touches', 'both', 'same head then pass', 'same head, card body changed'], populated(column).map(([size, { noise }]) => [size, noise.rounds, noise.noise, noise.sameHead, noise.outsideOnly, noise.both, noise.sameHeadThenPass, noise.sameHeadBodyChanged]))
}

export function measureLines(measure: CardMeasure, window: Window): string[] {
  return COLUMNS.flatMap((name) => {
    const column = measure[name]
    const falls = populated(column).reduce((sum, [, row]) => sum + row.spentFalls, 0)
    return [
      `== ${name === 'before' ? `merged before ${window.before}` : `merged at or after ${window.after}`}`,
      '',
      'cards, sessions and tokens',
      ...cardsTable(column),
      '',
      'verdict reasons (findings of changes rounds)',
      ...categoriesTable(column),
      '',
      'tokens by role (the rise of spent under each step)',
      ...rolesTable(column),
      ...(falls === 0 ? [] : [`spent fell ${falls} times inside a session; a fall adds nothing to a role`]),
      '',
      'mechanism noise among the changes rounds (each round once)',
      ...noiseTable(column),
      '',
    ]
  })
}

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value)
}

export function runCardMeasure(args: readonly string[], busPath: string, write: (line: string) => void): number {
  const { values } = parseArgs({ args: [...args], options: { before: { type: 'string' }, after: { type: 'string' }, list: { type: 'string' } } })
  if (values.before === undefined || values.after === undefined) {
    write('usage: card:measure --before <ts> --after <ts> [--list <category>]')
    return 2
  }
  if (values.list !== undefined && !isCategory(values.list)) {
    write(`--list takes one of ${CATEGORIES.join(', ')}`)
    return 2
  }
  const window = { before: values.before, after: values.after }
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const lines = values.list === undefined
      ? measureLines(cardMeasure(db, window), window)
      : findingsOf(db, window, values.list).map(({ card, pr, column, text }) => `${column} #${card} PR ${pr ?? '—'}: ${text}`)
    for (const line of lines)
      write(line)
    return 0
  }
  finally {
    db.close()
  }
}

const isEntry = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isEntry)
  process.exitCode = runCardMeasure(process.argv.slice(2), defaultBusPath(), line => process.stdout.write(`${line}\n`))

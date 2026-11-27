import type { DatabaseSync } from 'node:sqlite'
import type { BusCardStates, JournalEntry } from '../../../src/card/closed.js'
import type { EventRow } from '../../core/events-query.js'
import type { Decision } from './decisions.js'
import type { InForceDecision } from './index.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { closedFromBus, mergedFromBus } from '../../../src/card/closed.js'
import { defaultBusPath } from '../../core/db.js'
import { ofPr } from '../../core/events-query.js'
import { PR_OBSERVED, PR_OPENED } from '../../core/events.js'
import { busHistory } from '../../core/journal.js'
import { pnpmCommand } from '../../core/owner-commands.js'
import { busCardStates } from '../../core/tasks.js'
import { isFullSha } from '../../ports/identifier-shapes.js'
import { CARD_VARIABLE } from '../../ports/session.js'
import { calendarTerm, decisionsFileOf, decisionsFindings, decisionsRefusals, inForce, OWNER_SOURCE, parseDecisions, PREFIX, settleSupersedes, spentByCards, visibleToCard } from './decisions.js'

export const USAGE = `usage: ${pnpmCommand('decisions', '[<owner-decisions.md>]')}`

export const OWNER_EVEN_UNDER_THE_DECISION = 'R1'
export const ALLOW_MERGE = 'allow-merge'
export const CONTINUE_FIXES = 'continue-fixes'
const OWNER_PREFIX = `${OWNER_SOURCE.replace(/[[\]]/g, '\\$&')} `

export interface CleanUpdate {
  from: string
  to: string
}

export function namesPrAtHeadUnder(marker: string, text: string, pr: number, head: string): boolean {
  return new RegExp(`^(?:${OWNER_PREFIX})?${marker} PR #${pr} at ${head}(?![0-9a-f])`).test(text)
}

export function namesPrAtHead(text: string, pr: number, head: string): boolean {
  return namesPrAtHeadUnder(ALLOW_MERGE, text, pr, head)
}

export function headsOf(rows: readonly EventRow[]): string[] {
  return rows.flatMap(row => row.head === null ? [] : [row.head])
}

export function observedHeadsOf(db: DatabaseSync, pr: number): string[] {
  const heads = headsOf(ofPr(db, pr, { types: [PR_OPENED, PR_OBSERVED] }))
  return heads.filter((head, at) => at === 0 || heads[at - 1] !== head)
}

export function headsWithTheSameDiff(head: string, cleanUpdates: readonly CleanUpdate[]): string[] {
  const heads = [head]
  for (let current = head; ;) {
    const from = cleanUpdates.find(update => update.to === current)?.from
    if (from === undefined || heads.includes(from))
      return heads
    heads.push(from)
    current = from
  }
}

export function decisionUnder(marker: string, decisions: readonly InForceDecision[], pr: number, head: string, cleanUpdates: readonly CleanUpdate[]): number | null {
  if (!isFullSha(head))
    return null
  const heads = headsWithTheSameDiff(head, cleanUpdates)
  return decisions.find(decision => heads.some(decided => namesPrAtHeadUnder(marker, decision.text, pr, decided)))?.decisionId ?? null
}

export function continueFixesDecisionOf(decisions: readonly InForceDecision[], pr: number, head: string, cleanUpdates: readonly CleanUpdate[]): number | null {
  return decisionUnder(CONTINUE_FIXES, decisions, pr, head, cleanUpdates)
}

const TERM_IN_WORDS = /(?<![\p{L}\p{N}])до\s+(?<until>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)(?![\p{L}\p{N}])/gu

export function termInWords(body: string): string | null {
  const named = new Set([...body.matchAll(TERM_IN_WORDS)].map(match => match.groups!.until!))
  const [until] = named
  return named.size === 1 && calendarTerm(until!) ? until! : null
}

export function withTermInWords(decision: Decision): Decision {
  if (decision.term.until !== null || decision.term.unread)
    return decision
  const until = termInWords(decision.body)
  return until === null ? decision : { ...decision, term: { until, unread: false } }
}

export interface DecisionsReadDeps {
  decisions: string
  exists: (file: string) => boolean
  history: readonly JournalEntry[]
  bus: BusCardStates
  read: (file: string) => string
  out: (line: string) => void
  err: (line: string) => void
  finding?: (line: string) => void
  card?: number | null
}

export function sessionCardOf(env: NodeJS.ProcessEnv): number | null {
  const card = env[CARD_VARIABLE]?.trim() ?? ''
  return /^[1-9]\d*$/.test(card) ? Number(card) : null
}

export function archiveOf(file: string): string {
  return file.replace(/(?:\.md)?$/, '.archive.md')
}

export function defaultDecisionsFile(): string {
  return decisionsFileOf(defaultBusPath())
}

export function decisionsNumbered(file: string, read: (file: string) => string | null, number: number): Decision[] {
  return [file, archiveOf(file)].flatMap(each => parseDecisions(read(each) ?? '').decisions).filter(decision => decision.number === number)
}

export function settledCards(history: readonly JournalEntry[], bus: BusCardStates): Set<number> {
  const settled = [...closedFromBus(history, bus).keys(), ...mergedFromBus(history, bus)]
  return new Set(settled.filter(task => /^[1-9]\d*$/.test(task)).map(Number))
}

export function runDecisionsRead(args: string[], deps: DecisionsReadDeps): number {
  if (args.length > 1 || args[0]?.startsWith('--')) {
    deps.err(`${PREFIX}${USAGE}`)
    return 2
  }
  const file = args[0] ?? deps.decisions
  if (!deps.exists(file)) {
    deps.err(`${PREFIX}no decisions at ${file}`)
    return 1
  }
  const read = deps.read(file)
  const settled = settledCards(deps.history, deps.bus)
  const archiveFile = archiveOf(file)
  const archive = deps.exists(archiveFile) ? deps.read(archiveFile) : ''
  const text = settleSupersedes(read, archive)
  const refusals = decisionsRefusals(text, archive)
  if (refusals.length > 0) {
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}${file} refused: ${refusals.length} refusals, no decision read`)
    return 1
  }
  const decisions = parseDecisions(text).decisions.map(withTermInWords)
  const spent = new Set(spentByCards(decisions, card => settled.has(card)).map(decision => decision.number))
  for (const decision of inForce(decisions).filter(each => !spent.has(each.number) && visibleToCard(each, deps.card ?? null)))
    deps.out(decision.text)
  for (const line of decisionsFindings(text))
    deps.finding?.(line)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runDecisionsRead(process.argv.slice(2), {
    decisions: defaultDecisionsFile(),
    history: busHistory(defaultBusPath()),
    bus: busCardStates(defaultBusPath()),
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    out: line => console.log(line),
    err: line => console.error(line),
    finding: line => console.error(line),
    card: sessionCardOf(process.env),
  })
}

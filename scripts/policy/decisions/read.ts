import type { BusCardStates, JournalEntry } from '../../../src/card/closed.js'
import type { Decision } from './decisions.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { closedFromBus, mergedFromBus } from '../../../src/card/closed.js'
import { decisionsFileOf } from '../../core/bus-path.js'
import { defaultBusPath } from '../../core/db.js'
import { busHistory } from '../../core/journal.js'
import { pnpmCommand } from '../../core/owner-commands.js'
import { busCardStates } from '../../core/tasks.js'
import { CARD_VARIABLE } from '../../ports/session.js'
import { calendarTerm, decisionsFindings, decisionsRefusals, inForce, parseDecisions, PREFIX, settleSupersedes, spentByCards, visibleToCard } from './decisions.js'

export const USAGE = `usage: ${pnpmCommand('decisions', '[<owner-decisions.md>]')}`

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
    decisions: decisionsFileOf(defaultBusPath()),
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

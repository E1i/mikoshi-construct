import type { BusCardStates, JournalEntry } from '../../../src/card/closed.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { closedFromBus, mergedFromBus } from '../../../src/card/closed.js'
import { decisionsFileOf } from '../../core/bus-path.js'
import { defaultBusPath } from '../../core/db.js'
import { busHistory } from '../../core/journal.js'
import { busCardStates } from '../../core/tasks.js'
import { decisionsFindings, decisionsRefusals, inForce, parseDecisions, PREFIX, settleSupersedes, spendDecisions } from './decisions.js'

export const USAGE = 'usage: pnpm decisions [<owner-decisions.md>]'

export interface DecisionsReadDeps {
  decisions: string
  exists: (file: string) => boolean
  history: readonly JournalEntry[]
  bus: BusCardStates
  read: (file: string) => string
  out: (line: string) => void
  err: (line: string) => void
  finding?: (line: string) => void
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
  const text = settleSupersedes(spendDecisions(read, card => settled.has(card)), archive)
  const refusals = decisionsRefusals(text, archive)
  if (refusals.length > 0) {
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}${file} refused: ${refusals.length} refusals, no decision read`)
    return 1
  }
  for (const decision of inForce(parseDecisions(text).decisions))
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
  })
}

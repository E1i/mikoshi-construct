import { existsSync, readFileSync } from 'node:fs'
import { parseLedgerLine } from '../../src/commands/cost/ledger.js'

export const MALFORMED_LEDGER_LINE = 'malformed ledger line'

export interface LadderOutcome {
  status: string
  run: string | null
  iterations: number | null
  argsSha256?: string
}

function ledgerLines(runsPath: string): string[] {
  if (!existsSync(runsPath))
    return []
  return readFileSync(runsPath, 'utf8').split('\n').filter(line => line !== '')
}

export function countLedgerLines(runsPath: string): number {
  return ledgerLines(runsPath).length
}

export function readLadderOutcome(runsPath: string, linesBefore: number): LadderOutcome {
  const newLines = ledgerLines(runsPath).slice(linesBefore)
  if (newLines.length === 0)
    return { status: 'no ladder run', run: null, iterations: null }

  const last = parseLedgerLine(newLines[newLines.length - 1])
  if (typeof last === 'string')
    return { status: `${MALFORMED_LEDGER_LINE}: ${last}`, run: null, iterations: null }
  return {
    status: last.status,
    run: last.run,
    iterations: last.attempts.length,
    ...(last.argsSha256 === undefined ? {} : { argsSha256: last.argsSha256 }),
  }
}

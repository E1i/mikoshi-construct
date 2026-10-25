import { existsSync, readFileSync } from 'node:fs'
import { parseLedgerLine } from '../../src/commands/cost/ledger.js'

export type LedgerStage
  = | { kind: 'entry', status: string, run: string }
    | { kind: 'writing' }

const LEDGER_ROW_SCHEMA = 'contract/contours/ledger-row.schema.json'
const NOT_JSON = 'not JSON'
const RUN_MISSING = 'missing or invalid: run'

interface NumberedLine {
  text: string
  number: number
}

function faultOf(line: NumberedLine): { status: string, run: string } | string {
  const entry = parseLedgerLine(line.text)
  if (typeof entry === 'string')
    return entry
  if (entry.run === null)
    return RUN_MISSING
  return { status: entry.status, run: entry.run }
}

export function readLedgerStage(runsPath: string): LedgerStage | null {
  if (!existsSync(runsPath))
    return null

  const lines = readFileSync(runsPath, 'utf8').split('\n').map((text, index) => ({ text, number: index + 1 })).filter(line => line.text !== '')
  if (lines.length === 0)
    return null

  const refuse = (line: NumberedLine, reason: string): never => {
    throw new Error(`${runsPath} line ${line.number} is not a ledger row by ${LEDGER_ROW_SCHEMA} (${reason}): ${line.text.slice(0, 120)}`)
  }
  for (const line of lines.slice(0, -1)) {
    const fault = faultOf(line)
    if (typeof fault === 'string')
      refuse(line, fault)
  }

  const last = lines[lines.length - 1]
  const fault = faultOf(last)
  if (typeof fault !== 'string')
    return { kind: 'entry', ...fault }
  return fault === NOT_JSON ? { kind: 'writing' } : refuse(last, fault)
}

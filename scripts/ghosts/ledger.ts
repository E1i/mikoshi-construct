import type { TokenCount } from '../../src/commands/cost/ledger.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseLedgerLine } from '../../src/commands/cost/ledger.js'

export const MALFORMED_LEDGER_LINE = 'malformed ledger line'

export interface LadderOutcome {
  status: string
  run: string | null
  iterations: number | null
  actual: { tokens: TokenCount, minutes: number } | null
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
    return { status: 'no ladder run', run: null, iterations: null, actual: null }

  const last = parseLedgerLine(newLines[newLines.length - 1])
  if (typeof last === 'string')
    return { status: `${MALFORMED_LEDGER_LINE}: ${last}`, run: null, iterations: null, actual: null }
  return {
    status: last.status,
    run: last.run,
    iterations: last.attempts.length,
    actual: { tokens: last.tokens, minutes: last.seconds / 60 },
    ...(last.argsSha256 === undefined ? {} : { argsSha256: last.argsSha256 }),
  }
}

function ledgerKey(line: string): string {
  const entry = parseLedgerLine(line)
  return typeof entry !== 'string' && entry.run !== null ? `run ${entry.run}` : `line ${line}`
}

function stepCacheKey(line: string): string {
  try {
    const run = (JSON.parse(line) as { run?: unknown }).run
    return typeof run === 'string' ? `run ${run}` : `line ${line}`
  }
  catch {
    return `line ${line}`
  }
}

function carryLines(fromPath: string, intoPath: string, keyOf: (line: string) => string): number {
  const present = new Set(ledgerLines(intoPath).map(keyOf))
  const missing: string[] = []
  for (const line of ledgerLines(fromPath)) {
    const key = keyOf(line)
    if (present.has(key))
      continue
    present.add(key)
    missing.push(line)
  }
  if (missing.length === 0)
    return 0
  const existing = existsSync(intoPath) ? readFileSync(intoPath, 'utf8') : ''
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  mkdirSync(path.dirname(intoPath), { recursive: true })
  appendFileSync(intoPath, `${separator}${missing.map(line => `${line}\n`).join('')}`)
  return missing.length
}

export function carryLedgerLines(fromPath: string, intoPath: string): number {
  return carryLines(fromPath, intoPath, ledgerKey)
}

export function carryStepCacheLines(fromPath: string, intoPath: string): number {
  return carryLines(fromPath, intoPath, stepCacheKey)
}

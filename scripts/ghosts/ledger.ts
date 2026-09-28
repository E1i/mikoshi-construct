import { existsSync, readFileSync } from 'node:fs'

export interface LadderOutcome {
  status: string
  run: string | null
  iterations: number | null
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

  const last = JSON.parse(newLines[newLines.length - 1]) as { status: string, run: string, attempts: unknown[] }
  return { status: last.status, run: last.run, iterations: last.attempts.length }
}

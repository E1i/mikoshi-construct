import { existsSync, readFileSync } from 'node:fs'

export interface LedgerStage {
  status: string
  run: string
}

export function readLedgerStage(runsPath: string): LedgerStage | null {
  if (!existsSync(runsPath))
    return null

  const lines = readFileSync(runsPath, 'utf8').split('\n').filter(line => line !== '')
  if (lines.length === 0)
    return null

  const last = JSON.parse(lines[lines.length - 1]) as { status: string, run: string }
  return { status: last.status, run: last.run }
}

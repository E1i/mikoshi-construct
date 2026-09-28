import { existsSync, readFileSync } from 'node:fs'

export type LedgerStage
  = | { kind: 'entry', status: string, run: string }
    | { kind: 'writing' }

interface LedgerEntry {
  status: string
  run: string
}

function parseEntry(line: string): LedgerEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  }
  catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null)
    return null
  const { status, run } = parsed as Record<string, unknown>
  if (typeof status !== 'string' || typeof run !== 'string')
    return null
  return { status, run }
}

function isUnfinishedWrite(line: string): boolean {
  try {
    JSON.parse(line)
    return false
  }
  catch {
    return true
  }
}

export function readLedgerStage(runsPath: string): LedgerStage | null {
  if (!existsSync(runsPath))
    return null

  const lines = readFileSync(runsPath, 'utf8').split('\n').map((text, index) => ({ text, number: index + 1 })).filter(line => line.text !== '')
  if (lines.length === 0)
    return null

  const refuse = (line: { text: string, number: number }): never => {
    throw new Error(`${runsPath} line ${line.number} is not a ledger entry with a string status and run: ${line.text.slice(0, 120)}`)
  }
  for (const line of lines.slice(0, -1)) {
    if (parseEntry(line.text) === null)
      refuse(line)
  }

  const last = lines[lines.length - 1]
  const entry = parseEntry(last.text)
  if (entry !== null)
    return { kind: 'entry', ...entry }
  if (isUnfinishedWrite(last.text))
    return { kind: 'writing' }
  return refuse(last)
}

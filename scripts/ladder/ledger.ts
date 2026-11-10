import type { DatabaseSync } from 'node:sqlite'
import type { TokenCount } from '../../src/commands/cost/ledger.js'
import type { LedgerStage } from './watch-ledger.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { LEDGER_FILE, parseLedgerLine } from '../../src/commands/cost/ledger.js'
import { wiredBusOf } from '../../src/commands/run-record.js'
import { BUSY_TIMEOUT_MS } from '../core/db.js'
import { LADDER_RUN } from '../core/events.js'
import { openDatabase } from '../core/sqlite.js'
import { readLedgerStage } from './watch-ledger.js'

export const MALFORMED_LEDGER_LINE = 'malformed ledger line'
export const NO_LADDER_RUN = 'no ladder run'

const LEDGER_ROW_SCHEMA = 'contract/contours/ledger-row.schema.json'
const RUN_MISSING = 'missing or invalid: run'
const LAST_EVENT_ID = 'SELECT coalesce(max(id), 0) AS id FROM events'
const LAST_RUN_OF_CARD = 'SELECT id, payload FROM events WHERE type = ? AND card_id = ? AND id > ? ORDER BY id DESC LIMIT 1'

export type RunSource
  = | { kind: 'bus', busPath: string, card: number }
    | { kind: 'file', runsPath: string }

interface RunRow {
  id: number
  payload: string
}

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

function withReadOnlyBus<T>(busPath: string, read: (db: DatabaseSync) => T): T {
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

export function ledgerPathOf(root: string): string {
  return path.join(root, LEDGER_FILE)
}

export function runSourceOf(worktree: string, card: number, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): RunSource {
  const busPath = wiredBusOf({ dir: worktree, env, home })
  return busPath === null ? { kind: 'file', runsPath: ledgerPathOf(worktree) } : { kind: 'bus', busPath, card }
}

export function ladderRunMark(source: RunSource): number {
  if (source.kind === 'file')
    return ledgerLines(source.runsPath).length
  return withReadOnlyBus(source.busPath, db => Number((db.prepare(LAST_EVENT_ID).get() as { id: number }).id))
}

function lastRunOf(source: RunSource, after: number): RunRow | null {
  if (source.kind === 'file') {
    const lines = ledgerLines(source.runsPath)
    return lines.length > after ? { id: lines.length, payload: lines[lines.length - 1]! } : null
  }
  return withReadOnlyBus(source.busPath, db => (db.prepare(LAST_RUN_OF_CARD).get(LADDER_RUN, source.card, after) as RunRow | undefined) ?? null)
}

export function readLadderOutcome(source: RunSource, after: number): LadderOutcome {
  const row = lastRunOf(source, after)
  if (row === null)
    return { status: NO_LADDER_RUN, run: null, iterations: null, actual: null }

  const last = parseLedgerLine(row.payload)
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

export function readLadderStage(source: RunSource): LedgerStage | null {
  if (source.kind === 'file')
    return readLedgerStage(source.runsPath)
  const row = lastRunOf(source, 0)
  if (row === null)
    return null
  const entry = parseLedgerLine(row.payload)
  if (typeof entry !== 'string' && entry.run !== null)
    return { kind: 'entry', status: entry.status, run: entry.run }
  const fault = typeof entry === 'string' ? entry : RUN_MISSING
  throw new Error(`${LADDER_RUN} event ${row.id} in ${source.busPath} is not a ledger row by ${LEDGER_ROW_SCHEMA} (${fault}): ${row.payload.slice(0, 120)}`)
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

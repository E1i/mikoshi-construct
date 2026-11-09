import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import type { LaneOnDisk } from './admissions.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { appendEvent, defaultBusPath, inTransaction, openBus } from '../core/db.js'
import { defaultHandoffDir } from '../core/handoff-dir.js'
import { cardIdOf, isFullSha, prOf } from '../core/identifiers.js'
import { admitFromJournal, parkingLane } from './admissions.js'

export const PREFIX = '[bus:import] '
export const LADDER_RUN = 'ladder.run'
export const RUNS_JOURNAL = '.construct/runs.jsonl'

export interface ImportCount {
  imported: number
  present: number
  unreadable: number[]
  admitted: number
}

export type RunsImportCount = Omit<ImportCount, 'admitted'>

function entryOf(line: string): Record<string, unknown> | null {
  try {
    const entry = JSON.parse(line) as unknown
    return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

export function legacyEventOf(line: string, lineNumber: number): BusEvent | null {
  const entry = entryOf(line)
  if (entry === null || typeof entry.event !== 'string' || entry.event === '')
    return null
  return {
    ts: typeof entry.ts === 'string' ? entry.ts : null,
    type: entry.event,
    actor: null,
    cardId: cardIdOf(entry.card) ?? cardIdOf(entry.task),
    pr: prOf(entry.pr),
    head: isFullSha(entry.head) ? entry.head : null,
    dedupeKey: `legacy:${lineNumber}:${createHash('sha256').update(line).digest('hex')}`,
    payload: line,
    legacy: true,
  }
}

export function importJournal(db: DatabaseSync, journal: string, laneOnDisk: LaneOnDisk = () => null, now: () => Date = () => new Date()): ImportCount {
  const count: ImportCount = { imported: 0, present: 0, unreadable: [], admitted: 0 }
  inTransaction(db, () => {
    journal.split('\n').forEach((line, index) => {
      if (line.trim() === '')
        return
      const event = legacyEventOf(line, index + 1)
      if (event === null)
        count.unreadable.push(index + 1)
      else if (appendEvent(db, event))
        count.imported += 1
      else
        count.present += 1
    })
    count.admitted = admitFromJournal(db, now().toISOString(), laneOnDisk)
  })
  return count
}

export function importJournalFile(db: DatabaseSync, journal: string, laneOnDisk: LaneOnDisk, now: () => Date = () => new Date()): ImportCount | null {
  return existsSync(journal) ? importJournal(db, readFileSync(journal, 'utf8'), laneOnDisk, now) : null
}

export function journalPath(): string {
  return path.join(defaultHandoffDir(), 'ghosts.jsonl')
}

export function runEventOf(line: string, lineNumber: number): BusEvent | null {
  const entry = entryOf(line)
  if (entry === null)
    return null
  return {
    ts: typeof entry.at === 'string' ? entry.at : null,
    type: LADDER_RUN,
    actor: null,
    cardId: cardIdOf(entry.task),
    pr: null,
    head: null,
    dedupeKey: `${LADDER_RUN}:${lineNumber}:${createHash('sha256').update(line).digest('hex')}`,
    payload: line,
    legacy: true,
  }
}

export function importRuns(db: DatabaseSync, ledger: string): RunsImportCount {
  const count: RunsImportCount = { imported: 0, present: 0, unreadable: [] }
  inTransaction(db, () => {
    ledger.split('\n').forEach((line, index) => {
      if (line.trim() === '')
        return
      const event = runEventOf(line, index + 1)
      if (event === null)
        count.unreadable.push(index + 1)
      else if (appendEvent(db, event))
        count.imported += 1
      else
        count.present += 1
    })
  })
  return count
}

export function importRunsFile(db: DatabaseSync, ledger: string): RunsImportCount | null {
  return existsSync(ledger) ? importRuns(db, readFileSync(ledger, 'utf8')) : null
}

function unreadableClause(unreadable: readonly number[]): string {
  return `unreadable ${unreadable.length}${unreadable.length === 0 ? '' : ` (lines ${unreadable.join(', ')})`}`
}

function main(): number {
  const journal = journalPath()
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  try {
    const count = importJournalFile(db, journal, parkingLane(path.join(os.homedir(), '.construct', 'parking')))
    if (count === null) {
      console.error(`${PREFIX}no journal at ${journal}`)
      return 1
    }
    console.log(`${PREFIX}${journal} → ${busPath}: imported ${count.imported}, already present ${count.present}, ${unreadableClause(count.unreadable)}, cards admitted ${count.admitted}`)
    const ledger = path.join(process.cwd(), RUNS_JOURNAL)
    const runs = importRunsFile(db, ledger)
    if (runs !== null)
      console.log(`${PREFIX}${ledger} → ${busPath}: imported ${runs.imported}, already present ${runs.present}, ${unreadableClause(runs.unreadable)}`)
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()

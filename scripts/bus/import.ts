import type { DatabaseSync } from 'node:sqlite'
import type { LaneOnDisk } from './admissions.js'
import type { BusEvent } from './db.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { defaultParking } from '../ghosts/handoff-check.js'
import { admitFromJournal, parkingLane } from './admissions.js'
import { appendEvent, defaultBusPath, inTransaction, openBus } from './db.js'
import { cardIdOf, isFullSha, prOf } from './identifiers.js'

export const PREFIX = '[bus:import] '

export interface ImportCount {
  imported: number
  present: number
  unreadable: number[]
  admitted: number
}

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

export function journalPath(): string {
  return path.join(process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), 'ghosts.jsonl')
}

function main(): number {
  const journal = journalPath()
  if (!existsSync(journal)) {
    console.error(`${PREFIX}no journal at ${journal}`)
    return 1
  }
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  try {
    const count = importJournal(db, readFileSync(journal, 'utf8'), parkingLane(defaultParking(os.homedir())))
    console.log(`${PREFIX}${journal} → ${busPath}: imported ${count.imported}, already present ${count.present}, unreadable ${count.unreadable.length}${count.unreadable.length === 0 ? '' : ` (lines ${count.unreadable.join(', ')})`}, cards admitted ${count.admitted}`)
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()

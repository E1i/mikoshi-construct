import type { Expect } from './expect.js'
import type { LadderOutcome } from './ledger.js'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { appendEvent, defaultBusPath, openBus } from '../bus/db.js'
import { cardIdOf } from '../bus/identifiers.js'

export type RangeDiffOutcome = 'identical' | 'equal' | 'regenerated'

export interface JournalEntry {
  task: string
  session: string | null
  baseSha: string
  sketch: string | null
  install: number | null
  exit: number | null
  ladder: string
  run: string | null
  iterations: number | null
  class: string | null
  contour: unknown | null
  resultLine: 'present' | 'missing'
  total_cost_usd: number | null
  num_turns: number | null
  duration_ms: number | null
  usage: unknown | null
  agreedSha256: string
  approvedSha256: string
  approvedSketch: string | null
  rangeDiff: RangeDiffOutcome | null
  argsSha256: string | null
  expected: Expect | null
  actual: LadderOutcome['actual']
}

export type GhostLine = Record<string, unknown>

export const GHOST_LINE = 'ghost.line'

const GHOST_LINES = `SELECT payload FROM events WHERE type = '${GHOST_LINE}' AND legacy = 0 ORDER BY id`

export function recordGhostLine(writer: string, line: GhostLine, busPath: string = defaultBusPath()): void {
  const db = openBus(busPath)
  try {
    appendEvent(db, {
      ts: typeof line.ts === 'string' ? line.ts : new Date().toISOString(),
      type: GHOST_LINE,
      actor: `worker:${writer}:${process.pid}`,
      cardId: cardIdOf(line.card),
      pr: null,
      head: null,
      dedupeKey: `${GHOST_LINE}:${randomUUID()}`,
      payload: line,
      legacy: false,
    })
  }
  finally {
    db.close()
  }
}

export function ghostLines(busPath: string = defaultBusPath()): GhostLine[] {
  if (!existsSync(busPath))
    return []
  const db = openBus(busPath)
  try {
    return (db.prepare(GHOST_LINES).all() as { payload: string }[]).map(row => JSON.parse(row.payload) as GhostLine)
  }
  finally {
    db.close()
  }
}

export function ghostLinesText(busPath: string = defaultBusPath()): string {
  return ghostLines(busPath).map(line => `${JSON.stringify(line)}\n`).join('')
}

export function journalText(journalPath: string, busPath: string = defaultBusPath()): string {
  const file = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : ''
  const separator = file === '' || file.endsWith('\n') ? '' : '\n'
  return `${file}${separator}${ghostLinesText(busPath)}`
}

export function taskLine(entry: JournalEntry, ts: string = new Date().toISOString()): GhostLine {
  return { event: 'task', ts, ...entry, review: null }
}

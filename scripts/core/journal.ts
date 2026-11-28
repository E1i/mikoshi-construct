import type { Expect } from '../ladder/expect.js'
import type { LadderOutcome } from '../ladder/ledger.js'
import type { GhostLine } from './bus-history.js'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { cardIdOf } from '../ports/identifier-shapes.js'
import { ghostLinesText } from './bus-history.js'
import { appendEvent, defaultBusPath, openBus } from './db.js'
import { declaredPayload, GHOST_LINE } from './events.js'

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

export function recordGhostLine(writer: string, line: object, busPath: string = defaultBusPath()): void {
  const fields = line as GhostLine
  const db = openBus(busPath)
  try {
    appendEvent(db, {
      ts: typeof fields.ts === 'string' ? fields.ts : new Date().toISOString(),
      type: GHOST_LINE,
      actor: `worker:${writer}:${process.pid}`,
      cardId: cardIdOf(fields.card),
      pr: null,
      head: null,
      dedupeKey: `${GHOST_LINE}:${randomUUID()}`,
      payload: declaredPayload(GHOST_LINE, line),
      legacy: false,
    })
  }
  finally {
    db.close()
  }
}

export function withGhostLines(file: string | null, busPath: string = defaultBusPath()): string {
  const text = file ?? ''
  const separator = text === '' || text.endsWith('\n') ? '' : '\n'
  return `${text}${separator}${ghostLinesText(busPath)}`
}

export function journalText(journalPath: string, busPath: string = defaultBusPath()): string {
  return withGhostLines(existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : null, busPath)
}

export function taskLine(entry: JournalEntry, ts: string = new Date().toISOString()) {
  return { event: 'task', ts, ...entry, review: null }
}

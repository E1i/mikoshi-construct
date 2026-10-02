import type { Ui } from '../../ui/console.js'
import type { LedgerReading } from '../cost/ledger.js'
import type { PrsReading } from './prs.js'
import type { BoardView } from './view.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { LEDGER_FILE, readLedger } from '../cost/ledger.js'
import { ladderItems, prItems } from './items.js'
import { PRS_COMMAND, readPrs } from './prs.js'
import { tableLines } from './table.js'
import { buildView, FINISHED_SHOWN_HOURS, STALE_HOURS } from './view.js'

export { PRS_FROM_STDIN } from './prs.js'
export { STALE_HOURS }

export const BOARD_EXIT = { shown: 0 }
export const BOARD_FORMAT = 'user-board/1'
export const BOARD_JSON_SCHEMA_VERSION = 1
export const IMPLEMENT_SKILL = '.claude/skills/implement/SKILL.md'
const PULL_REQUESTS_UNKNOWN = 'pull requests'

export interface BoardOptions {
  all: boolean
  staleHours: number
  prs: string | undefined
  readStdin: () => string
  now?: Date
}

export interface BoardReading {
  ledgerPresent: boolean
  ledger: LedgerReading
  prs: PrsReading
  implement: boolean
  view: BoardView
}

export function readBoard(dir: string, options: BoardOptions): BoardReading {
  const now = options.now ?? new Date()
  const ledger = readLedger(dir)
  const prs = readPrs(options.prs, options.readStdin)
  const items = [...ladderItems(ledger.entries), ...(prs.status === 'read' ? prItems(prs.prs) : [])]
  return {
    ledgerPresent: existsSync(path.join(dir, LEDGER_FILE)),
    ledger,
    prs,
    implement: existsSync(path.join(dir, IMPLEMENT_SKILL)),
    view: buildView(items, now, options),
  }
}

function ledgerLine(ui: Ui, reading: BoardReading): string {
  const { lore } = ui
  const base = reading.ledgerPresent ? lore.boardLedgerRead(LEDGER_FILE, reading.ledger.entries.length) : lore.boardLedgerAbsent(LEDGER_FILE)
  const lines = reading.ledger.malformed.map(entry => entry.line)
  return lines.length === 0 ? base : `${base}; ${lore.boardLedgerMalformed(lines)}`
}

function prsLine(ui: Ui, prs: PrsReading): string {
  switch (prs.status) {
    case 'read': return ui.lore.boardPrsRead(prs.file, prs.prs.length)
    case 'unreadable': return ui.lore.boardPrsUnreadable(prs.file, prs.reason)
    case 'not read': return ui.lore.boardPrsNotRead
  }
}

function ledgerClause(ui: Ui, reading: BoardReading): string | undefined {
  if (!reading.implement)
    return undefined
  return reading.ledger.entries.length === 0 ? ui.lore.boardNoLadderRuns(LEDGER_FILE) : ui.lore.boardNoRecentLadderRuns(LEDGER_FILE, FINISHED_SHOWN_HOURS)
}

function prsClause(ui: Ui, prs: PrsReading): string {
  switch (prs.status) {
    case 'read': return ui.lore.boardNoOpenPrs
    case 'unreadable': return ui.lore.boardPrsClauseUnreadable(prs.reason)
    case 'not read': return ui.lore.boardPrsClauseNotRead(PRS_COMMAND)
  }
}

function nothingOpenLines(ui: Ui, reading: BoardReading): string[] {
  return [
    ui.lore.boardNothing(ledgerClause(ui, reading), prsClause(ui, reading.prs), reading.prs.status),
    reading.implement ? ui.lore.boardStart : ui.lore.boardNoImplement,
  ]
}

function mergedLines(ui: Ui, view: BoardView): string[] {
  if (view.merged.length === 0 && view.hidden === 0)
    return []
  return [ui.lore.boardMerged(view.merged.map(row => row.task), view.hidden > 0)]
}

export function printBoard(ui: Ui, reading: BoardReading): number {
  const { view } = reading
  const { summary } = view
  ui.line(ui.lore.boardSummary(summary.open, summary.running, summary.waiting, summary.blocked, summary.stale, FINISHED_SHOWN_HOURS, summary.merged))
  ui.line(ledgerLine(ui, reading))
  ui.line(prsLine(ui, reading.prs))
  for (const line of view.table.length === 0 ? nothingOpenLines(ui, reading) : tableLines(view.table, ui.theme, ui.lore))
    ui.line(line)
  for (const line of mergedLines(ui, view))
    ui.line(line)
  return BOARD_EXIT.shown
}

function unknownTally(reading: BoardReading): Record<string, number> {
  const tally: Record<string, number> = {
    [LEDGER_FILE]: (reading.ledgerPresent ? 0 : 1) + reading.ledger.malformed.length,
    [PULL_REQUESTS_UNKNOWN]: reading.prs.status === 'read' ? 0 : 1,
  }
  return Object.fromEntries(Object.entries(tally).filter(([, count]) => count > 0))
}

function prsSource(prs: PrsReading): Record<string, unknown> {
  switch (prs.status) {
    case 'read': return { status: prs.status, file: prs.file, count: prs.prs.length }
    case 'unreadable': return { status: prs.status, file: prs.file, reason: prs.reason }
    case 'not read': return { status: prs.status }
  }
}

export function boardJson(reading: BoardReading): Record<string, unknown> {
  const { view, prs } = reading
  return {
    schemaVersion: BOARD_JSON_SCHEMA_VERSION,
    format: BOARD_FORMAT,
    summary: view.summary,
    sources: {
      ledger: { status: reading.ledgerPresent ? 'read' : 'absent', file: LEDGER_FILE, malformed: reading.ledger.malformed },
      prs: prsSource(prs),
    },
    rows: view.rows.map(row => ({ task: row.task, path: row.path, stage: row.stage, state: row.state, at: Number.isNaN(row.at.getTime()) ? null : row.at.toISOString(), next: row.next, tone: row.tone, stale: row.stale, shown: row.shown })),
    unknown: unknownTally(reading),
  }
}

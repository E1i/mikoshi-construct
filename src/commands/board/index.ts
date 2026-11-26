import type { LastReduced } from '../../../scripts/core/bus-readings.js'
import type { Ui } from '../../ui/console.js'
import type { BusDb } from '../cost/bus.js'
import type { LedgerReading } from '../cost/ledger.js'
import type { BoardBus, BusFacts, BusReader, BusReading, LastReducedRows } from './bus.js'
import type { BoardGateRuns } from './gate-runs.js'
import type { BoardHeal } from './heal.js'
import type { PrsReading } from './prs.js'
import type { BoardView } from './view.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { behindLine, CARDS, currentLane, IN_ORDER_MARK, readLastReduced } from '../../../scripts/core/bus-readings.js'
import { busPanelRow, cardsWithTheirLines, EITHER_JOURNAL, events, lastObjectFieldPerCard, lastReducedOwnerWaits, lastSlotsPerQueue, latest, newestEventsOfEachCard, tasksInStates } from '../../../scripts/core/card-readings.js'
import { ofPr } from '../../../scripts/core/pr-readings.js'
import { windowRoleRows } from '../../../scripts/nodes/restart/role-readings.js'
import { withReadOnlyBus } from '../cost/bus.js'
import { LEDGER_FILE, readLedger } from '../cost/ledger.js'
import { boardFacts } from './bus.js'
import { drainLines, drainsAt } from './drain.js'
import { gateRunsLines, gateRunsOf } from './gate-runs.js'
import { healAt, healLines } from './heal.js'
import { ladderItems, prItems } from './items.js'
import { PRS_COMMAND, readPrs } from './prs.js'
import { screenLines } from './screens.js'
import { tableLines } from './table.js'
import { buildView, FINISHED_SHOWN_HOURS, STALE_HOURS } from './view.js'

export type { OwnerWait, OwnerWaitNeed } from '../../../scripts/core/bus-readings.js'
export type { EventRow, TaskRow } from '../../../scripts/core/card-readings.js'
export type { BusDb } from '../cost/bus.js'
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
  bus?: BusReader
  version?: string
  mode?: string
  geek?: boolean
}

export interface BoardReading {
  header: { version: string, mode: string | undefined } | undefined
  geek: boolean
  all: boolean
  bus: BusReading | undefined
  heal?: BoardHeal | null
  gateRuns?: BoardGateRuns | null
  ledgerPresent: boolean
  ledger: LedgerReading
  prs: PrsReading
  implement: boolean
  view: BoardView
}

export interface RawSectionFlags {
  geek: boolean
  all: boolean
  staleHours: number
  prs: string | undefined
}

export function rawSectionsAsked(flags: RawSectionFlags): boolean {
  return flags.geek || flags.staleHours !== STALE_HOURS || flags.prs !== undefined
}

function behindAsLine<T>(reading: LastReduced<T>): LastReducedRows<T> {
  return { rows: reading.rows, behind: reading.behind === null ? null : behindLine(reading.behind) }
}

export interface BoardReads {
  eitherJournal: typeof EITHER_JOURNAL
  events: typeof events
  latest: typeof latest
  lastObjectFieldPerCard: typeof lastObjectFieldPerCard
  lastSlotsPerQueue: typeof lastSlotsPerQueue
  newestEventsOfEachCard: typeof newestEventsOfEachCard
  busPanelRow: typeof busPanelRow
  tasksInStates: typeof tasksInStates
  cardsWithTheirLines: typeof cardsWithTheirLines
}

export const BOARD_BUS: BoardBus = {
  eitherJournal: EITHER_JOURNAL,
  events,
  latest,
  lastObjectFieldPerCard,
  lastSlotsPerQueue,
  newestEventsOfEachCard,
  busPanelRow,
  tasksInStates,
  cardsWithTheirLines,
  exists: existsSync,
  readOnly: withReadOnlyBus,
  inOrderMark: IN_ORDER_MARK,
  lastReducedCards: (db, read) => behindAsLine(readLastReduced(db, [CARDS], read)),
  lastReducedOwnerWaits: db => behindAsLine(lastReducedOwnerWaits(db)),
  currentLane,
  windowRoles: windowRoleRows,
  reviewVerdict: (db, pr) => ofPr(db, pr)?.verdict_on_head ?? null,
}

export function busFacts(db: BusDb, now: Date): BusFacts {
  return boardFacts(BOARD_BUS, db, now)
}

export function readBoard(dir: string, options: BoardOptions): BoardReading {
  const now = options.now ?? new Date()
  const ledger = readLedger(dir)
  const prs = readPrs(options.prs, options.readStdin)
  const items = [...ladderItems(ledger.entries), ...(prs.status === 'read' ? prItems(prs.prs) : [])]
  const bus = options.bus?.(BOARD_BUS)
  return {
    header: options.version === undefined ? undefined : { version: options.version, mode: options.mode },
    geek: options.geek ?? false,
    all: options.all,
    bus,
    heal: bus?.status === 'read' ? healAt(bus.file, now) : null,
    gateRuns: bus?.status === 'read' ? gateRunsOf(bus.gateRuns) : null,
    ledgerPresent: ledger.origin?.kind !== 'absent',
    ledger,
    prs,
    implement: existsSync(path.join(dir, IMPLEMENT_SKILL)),
    view: buildView(items, now, { ...options, drains: bus?.status === 'read' ? drainsAt(bus.file, now) : [] }),
  }
}

function ledgerFile(reading: BoardReading): string {
  return reading.ledger.origin?.file ?? LEDGER_FILE
}

function ledgerLine(ui: Ui, reading: BoardReading): string {
  const { lore } = ui
  const base = reading.ledgerPresent ? lore.boardLedgerRead(ledgerFile(reading), reading.ledger.entries.length) : lore.boardLedgerAbsent(LEDGER_FILE)
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
  return reading.ledger.entries.length === 0 ? ui.lore.boardNoLadderRuns(ledgerFile(reading)) : ui.lore.boardNoRecentLadderRuns(ledgerFile(reading), FINISHED_SHOWN_HOURS)
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

function busLines(ui: Ui, bus: BusReading, all: boolean): string[] {
  switch (bus.status) {
    case 'read': return screenLines(bus.facts, ui.lore, all)
    case 'absent': return [ui.lore.boardBusAbsent(bus.file)]
    case 'unreadable': return [ui.lore.boardBusUnreadable(bus.file, bus.reason)]
  }
}

export function printBoard(ui: Ui, reading: BoardReading): number {
  if (reading.header !== undefined)
    ui.line(ui.lore.boardHeader(reading.header.version, reading.header.mode))
  if (reading.bus !== undefined && !(reading.geek && reading.bus.status === 'read')) {
    for (const line of [...busLines(ui, reading.bus, reading.all), ...drainLines(ui.lore, reading.view.drains), ...healLines(ui.lore, reading.heal ?? null), ...gateRunsLines((role, task, detail) => ui.lore.boardServiceLine(role, task, undefined, detail), reading.gateRuns ?? null)])
      ui.line(line)
    if (reading.bus.status === 'read')
      return BOARD_EXIT.shown
  }
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
      ledger: { status: reading.ledgerPresent ? 'read' : 'absent', file: ledgerFile(reading), malformed: reading.ledger.malformed },
      prs: prsSource(prs),
    },
    rows: view.rows.map(row => ({ task: row.task, path: row.path, stage: row.stage, state: row.state, at: Number.isNaN(row.at.getTime()) ? null : row.at.toISOString(), next: row.next, tone: row.tone, stale: row.stale, shown: row.shown })),
    unknown: unknownTally(reading),
  }
}

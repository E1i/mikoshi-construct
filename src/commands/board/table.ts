import type { Lore } from '../../ui/lore.js'
import type { Theme } from '../../ui/theme.js'
import type { Age, Row } from './view.js'
import { stripVTControlCharacters } from 'node:util'
import { NO_NEXT } from './items.js'

const BORDERS = {
  top: ['┌', '┬', '┐'],
  under: ['├', '┼', '┤'],
  bottom: ['└', '┴', '┘'],
} as const
const RULE = '─'
const SEPARATOR = '│'

function formatMinutes(minutes: number): string {
  if (minutes < 60)
    return `${minutes}m`
  if (minutes < 24 * 60)
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(minutes / (24 * 60))}d${Math.floor((minutes % (24 * 60)) / 60)}h`
}

export function formatAge(age: Age, lore: Lore): string {
  return age.skew ? lore.boardClockSkew(formatMinutes(age.minutes)) : formatMinutes(age.minutes)
}

function visibleWidth(text: string): number {
  return stripVTControlCharacters(text).length
}

function padded(text: string, width: number): string {
  return `${text}${' '.repeat(width - visibleWidth(text))}`
}

function borderLine([left, joint, right]: readonly [string, string, string], widths: number[]): string {
  return `${left}${widths.map(width => RULE.repeat(width + 2)).join(joint)}${right}`
}

function cellLine(cells: string[], widths: number[]): string {
  return `${SEPARATOR} ${cells.map((cell, column) => padded(cell, widths[column]!)).join(` ${SEPARATOR} `)} ${SEPARATOR}`
}

function rowCells(row: Row, theme: Theme, lore: Lore): string[] {
  const paint = row.tone === 'red' ? theme.primary : (text: string) => text
  const next = row.stale && row.age !== undefined ? `${lore.boardStale(formatAge(row.age, lore))}${row.next}` : row.next
  const expected = row.spent === undefined ? NO_NEXT : lore.boardExpectNotRecorded
  const actual = row.spent === undefined ? NO_NEXT : lore.boardActual(row.spent.tokens, row.spent.seconds)
  return [row.task, row.path, paint(row.stage), row.age === undefined ? NO_NEXT : formatAge(row.age, lore), paint(next), expected, actual]
}

export function tableLines(rows: Row[], theme: Theme, lore: Lore): string[] {
  const grid = [lore.boardColumns, ...rows.map(row => rowCells(row, theme, lore))]
  const [header, ...body] = grid
  const widths = lore.boardColumns.map((_, column) => Math.max(...grid.map(cells => visibleWidth(cells[column]!))))
  return [
    borderLine(BORDERS.top, widths),
    cellLine(header!, widths),
    borderLine(BORDERS.under, widths),
    ...body.map(cells => cellLine(cells, widths)),
    borderLine(BORDERS.bottom, widths),
  ]
}

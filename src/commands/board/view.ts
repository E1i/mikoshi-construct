import type { Item } from './items.js'

export const STALE_HOURS = 4
export const FINISHED_SHOWN_HOURS = 12

const OPEN_STATES = ['running', 'waiting', 'blocked']
const ROW_ORDER = ['blocked', 'stale', 'waiting', 'running']

export interface Age {
  minutes: number
  skew: boolean
}

export interface Row extends Item {
  age: Age | undefined
  stale: boolean
  shown: boolean
}

export interface Summary {
  open: number
  running: number
  waiting: number
  blocked: number
  stale: number
  merged: number
}

export interface BoardView {
  rows: Row[]
  table: Row[]
  merged: Row[]
  hidden: number
  summary: Summary
}

export function ageSince(at: Date, now: Date): Age | undefined {
  if (Number.isNaN(at.getTime()))
    return undefined
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
  return minutes < 0 ? { minutes: -minutes, skew: true } : { minutes, skew: false }
}

function isOpen(item: Item): boolean {
  return OPEN_STATES.includes(item.state)
}

function isRecent(age: Age | undefined): boolean {
  return age === undefined || age.skew || age.minutes <= FINISHED_SHOWN_HOURS * 60
}

function isShown(item: Item, age: Age | undefined, all: boolean): boolean {
  if (all || (item.path === 'pr' && isOpen(item)))
    return true
  return (isOpen(item) || item.state === 'merged') && isRecent(age)
}

function rowOf(item: Item, now: Date, all: boolean, staleHours: number): Row {
  const age = ageSince(item.at, now)
  const stale = isOpen(item) && age !== undefined && !age.skew && age.minutes > staleHours * 60
  return { ...item, age, stale, shown: isShown(item, age, all) }
}

function rank(row: Row): number {
  const found = ROW_ORDER.indexOf(row.stale ? 'stale' : row.state)
  return found === -1 ? ROW_ORDER.length : found
}

const UNKNOWN_ELAPSED = -Number.MAX_SAFE_INTEGER

function elapsed(age: Age | undefined): number {
  if (age === undefined)
    return UNKNOWN_ELAPSED
  return age.skew ? -age.minutes : age.minutes
}

function oldestFirst(a: Row, b: Row): number {
  return rank(a) - rank(b) || elapsed(b.age) - elapsed(a.age)
}

function newestFirst(a: Row, b: Row): number {
  return b.at.getTime() - a.at.getTime()
}

function count(rows: Row[], state: string): number {
  return rows.filter(row => row.state === state).length
}

export function buildView(items: Item[], now: Date, options: { all: boolean, staleHours: number }): BoardView {
  const rows = items.map(item => rowOf(item, now, options.all, options.staleHours))
  const table = rows.filter(row => row.shown && row.state !== 'merged').sort(oldestFirst)
  const open = table.filter(isOpen)
  const merged = rows.filter(row => row.state === 'merged')
  return {
    rows,
    table,
    merged: merged.filter(row => row.shown).sort(newestFirst),
    hidden: rows.filter(row => !row.shown).length,
    summary: {
      open: open.length,
      running: count(open, 'running'),
      waiting: count(open, 'waiting'),
      blocked: count(open, 'blocked'),
      stale: open.filter(row => row.stale).length,
      merged: merged.filter(row => isRecent(row.age)).length,
    },
  }
}

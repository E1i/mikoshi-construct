import { Buffer } from 'node:buffer'
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { MERGE_DONE, REVIEW_RECORDED } from '../bus/card-automaton.js'
import { defaultBusPath, openBus } from '../bus/db.js'
import { CARD_CLOSED } from '../bus/launch-candidates.js'
import { PR_OBSERVED } from '../bus/operator-work.js'
import { GHOST_JOURNAL } from '../shift/places.js'
import { STOP_EVENT } from '../shift/relaunch.js'

export const WAKING_EVENTS = ['merge', 'fall', 'relaunch-stop', 'stop']
export const WAKING_BUS_EVENTS = [STOP_EVENT, REVIEW_RECORDED, MERGE_DONE, CARD_CLOSED, PR_OBSERVED]
export const FAILED_CI = 'red'
export const POLL_MS = 500
export const USAGE = 'usage: pnpm miko:watch [--once] [--pid <pid>…]'
export const ONCE = '--once'
export const WATCHING = 'miko:watch: what is already there is read; watching for what comes next'

export interface WatchState {
  offset: number
  rest: string
  busId: number
  ciByPr: Map<number | null, { head: string | null, ci: unknown }>
  pids: Set<number>
}

export interface BusEvent {
  id: number
  type: string
  pr: number | null
  head: string | null
  payload: string
}

export interface WatchDeps {
  size: () => number
  readFrom: (offset: number, end: number) => string
  lastBusId: () => number
  busEventsAfter: (id: number) => BusEvent[]
  alive: (pid: number) => boolean
}

export interface WatchArgs {
  pids: number[]
  once: boolean
}

export function parseWatchArgs(args: string[]): WatchArgs | undefined {
  const pids: number[] = []
  let afterPid = false
  let once = false
  for (const arg of args) {
    if (arg === ONCE) {
      once = true
      continue
    }
    if (arg === '--pid') {
      afterPid = true
      continue
    }
    if (!afterPid || !/^[1-9]\d*$/.test(arg))
      return undefined
    pids.push(Number(arg))
  }
  return afterPid && pids.length === 0 ? undefined : { pids, once }
}

export function wakingEvent(line: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    const event = typeof parsed === 'object' && parsed !== null ? (parsed as { event?: unknown }).event : undefined
    return typeof event === 'string' && WAKING_EVENTS.includes(event.toLowerCase()) ? event : undefined
  }
  catch {
    return undefined
  }
}

export function watchState(deps: WatchDeps, pids: number[]): WatchState {
  return { offset: deps.size(), rest: '', busId: deps.lastBusId(), ciByPr: new Map(), pids: new Set(pids) }
}

function journalLines(state: WatchState, deps: WatchDeps): string[] {
  const size = deps.size()
  if (size < state.offset) {
    state.offset = size
    state.rest = ''
  }
  if (size === state.offset)
    return []
  const text = state.rest + deps.readFrom(state.offset, size)
  state.offset = size
  const lines = text.split('\n')
  state.rest = lines.pop() ?? ''
  return lines.filter(line => wakingEvent(line) !== undefined).map(line => `journal ${line}`)
}

function ciOf(payload: string): unknown {
  try {
    const parsed: unknown = JSON.parse(payload)
    return typeof parsed === 'object' && parsed !== null ? (parsed as { ci?: unknown }).ci : undefined
  }
  catch {
    return undefined
  }
}

function turnsRed(state: WatchState, event: BusEvent): boolean {
  const before = state.ciByPr.get(event.pr)
  const now = { head: event.head, ci: ciOf(event.payload) }
  state.ciByPr.set(event.pr, now)
  return now.ci === FAILED_CI && (before?.ci !== FAILED_CI || before.head !== now.head)
}

export function wakesTheWindow(state: WatchState, event: BusEvent): boolean {
  if (!WAKING_BUS_EVENTS.includes(event.type))
    return false
  return event.type !== PR_OBSERVED || turnsRed(state, event)
}

function busLines(state: WatchState, deps: WatchDeps): string[] {
  const events = deps.busEventsAfter(state.busId)
  for (const event of events)
    state.busId = Math.max(state.busId, event.id)
  return events.filter(event => wakesTheWindow(state, event)).map(event => `bus ${event.type} ${event.payload}`)
}

function exitedPids(state: WatchState, deps: WatchDeps): string[] {
  const exited = [...state.pids].filter(pid => !deps.alive(pid))
  for (const pid of exited)
    state.pids.delete(pid)
  return exited.map(pid => `pid ${pid} exited`)
}

export function tick(state: WatchState, deps: WatchDeps): string[] {
  return [...journalLines(state, deps), ...busLines(state, deps), ...exitedPids(state, deps)]
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  }
  catch {
    return 0
  }
}

function readFrom(file: string, offset: number, end: number): string {
  const length = end - offset
  if (length <= 0)
    return ''
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    const read = readSync(fd, buffer, 0, length, offset)
    return buffer.subarray(0, read).toString('utf8')
  }
  finally {
    closeSync(fd)
  }
}

function lastBusId(bus: string): number {
  const db = openBus(bus)
  try {
    const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as { id: number }
    return Number(row.id)
  }
  finally {
    db.close()
  }
}

function busEventsAfter(bus: string, id: number): BusEvent[] {
  const db = openBus(bus)
  try {
    const types = WAKING_BUS_EVENTS.map(() => '?').join(', ')
    const rows = db.prepare(`SELECT id, type, pr, head, payload FROM events WHERE type IN (${types}) AND id > ? ORDER BY id`).all(...WAKING_BUS_EVENTS, id) as Array<{ id: number, type: string, pr: number | null, head: string | null, payload: string }>
    return rows.map(row => ({ id: Number(row.id), type: row.type, pr: row.pr === null ? null : Number(row.pr), head: row.head, payload: row.payload }))
  }
  finally {
    db.close()
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseWatchArgs(process.argv.slice(2))
  if (args === undefined) {
    console.error(USAGE)
    process.exit(2)
  }
  const journal = path.join(process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL)
  const bus = defaultBusPath()
  const deps: WatchDeps = {
    size: () => sizeOf(journal),
    readFrom: (offset, end) => readFrom(journal, offset, end),
    lastBusId: () => lastBusId(bus),
    busEventsAfter: id => busEventsAfter(bus, id),
    alive,
  }
  const state = watchState(deps, args.pids)
  console.error(WATCHING)
  for (let woken = false; !woken;) {
    const lines = tick(state, deps)
    const printed = args.once ? lines.slice(0, 1) : lines
    for (const line of printed)
      process.stdout.write(`${line}\n`)
    woken = args.once && printed.length > 0
    if (!woken)
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

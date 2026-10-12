import { Buffer } from 'node:buffer'
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { defaultBusPath, openBus } from '../bus/db.js'
import { GHOST_JOURNAL } from '../shift/places.js'
import { STOP_EVENT } from '../shift/relaunch.js'

export const WAKING_EVENTS = ['merge', 'fall', 'relaunch-stop', 'stop']
export const POLL_MS = 500
export const USAGE = 'usage: pnpm miko:watch [--pid <pid>…]'
export const WATCHING = 'miko:watch: what is already there is read; watching for what comes next'

export interface WatchState {
  offset: number
  rest: string
  busId: number
  pids: Set<number>
}

export interface BusStop {
  id: number
  payload: string
}

export interface WatchDeps {
  size: () => number
  readFrom: (offset: number, end: number) => string
  lastBusId: () => number
  busStopsAfter: (id: number) => BusStop[]
  alive: (pid: number) => boolean
}

export function parseWatchArgs(args: string[]): number[] | undefined {
  const pids: number[] = []
  let afterPid = false
  for (const arg of args) {
    if (arg === '--pid') {
      afterPid = true
      continue
    }
    if (!afterPid || !/^[1-9]\d*$/.test(arg))
      return undefined
    pids.push(Number(arg))
  }
  return afterPid && pids.length === 0 ? undefined : pids
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
  return { offset: deps.size(), rest: '', busId: deps.lastBusId(), pids: new Set(pids) }
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

function busStops(state: WatchState, deps: WatchDeps): string[] {
  const stops = deps.busStopsAfter(state.busId)
  for (const stop of stops)
    state.busId = Math.max(state.busId, stop.id)
  return stops.map(stop => `bus ${stop.payload}`)
}

function exitedPids(state: WatchState, deps: WatchDeps): string[] {
  const exited = [...state.pids].filter(pid => !deps.alive(pid))
  for (const pid of exited)
    state.pids.delete(pid)
  return exited.map(pid => `pid ${pid} exited`)
}

export function tick(state: WatchState, deps: WatchDeps): string[] {
  return [...journalLines(state, deps), ...busStops(state, deps), ...exitedPids(state, deps)]
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

function busStopsAfter(bus: string, id: number): BusStop[] {
  const db = openBus(bus)
  try {
    const rows = db.prepare('SELECT id, payload FROM events WHERE type = ? AND id > ? ORDER BY id').all(STOP_EVENT, id) as Array<{ id: number, payload: string }>
    return rows.map(row => ({ id: Number(row.id), payload: row.payload }))
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
  const pids = parseWatchArgs(process.argv.slice(2))
  if (pids === undefined) {
    console.error(USAGE)
    process.exit(2)
  }
  const journal = path.join(process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL)
  const bus = defaultBusPath()
  const deps: WatchDeps = {
    size: () => sizeOf(journal),
    readFrom: (offset, end) => readFrom(journal, offset, end),
    lastBusId: () => lastBusId(bus),
    busStopsAfter: id => busStopsAfter(bus, id),
    alive,
  }
  const state = watchState(deps, pids)
  console.error(WATCHING)
  for (;;) {
    for (const line of tick(state, deps))
      process.stdout.write(`${line}\n`)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

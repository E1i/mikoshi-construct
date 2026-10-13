import type { WatchCursor } from './watch-store.js'
import { Buffer } from 'node:buffer'
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { MERGE_DONE, REVIEW_RECORDED } from '../bus/card-automaton.js'
import { defaultBusPath, openBus } from '../bus/db.js'
import { CARD_CLOSED } from '../bus/launch-candidates.js'
import { PR_CLOSED } from '../bus/observations.js'
import { PR_OBSERVED } from '../bus/operator-work.js'
import { GHOST_JOURNAL } from '../shift/places.js'
import { STOP_EVENT } from '../shift/relaunch.js'
import { WatchRefusal } from './watch-refusal.js'
import { ONCE_STORE, OnceStore } from './watch-store.js'

export const WAKING_EVENTS = ['merge', 'fall', 'relaunch-stop', 'stop']
export const WAKING_BUS_EVENTS = [STOP_EVENT, REVIEW_RECORDED, MERGE_DONE, PR_CLOSED, CARD_CLOSED, PR_OBSERVED]
export const FAILED_CI = 'red'
export const POLL_MS = 500
export const USAGE = 'usage: pnpm miko:watch [--once [--card <N>]] [--pid <pid>…]'
export const ONCE = '--once'
export const CARD = '--card'
export const WATCHING = 'miko:watch: what is already there is read; watching for what comes next'
export const WATCHING_FROM_CURSOR = 'miko:watch: reading from the --once cursor; watching'
export const LEGACY_CURSOR = 'miko-watch.json'

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
  cardId: number | null
  pr: number | null
  head: string | null
  payload: string
}

export interface WatchDeps {
  journal: string
  bus: string
  size: () => number
  readFrom: (offset: number, end: number) => string
  lastBusId: () => number
  busEventsAfter: (id: number) => BusEvent[]
  observedUpTo: (id: number) => BusEvent[]
  alive: (pid: number) => boolean
  emit: (line: string) => Promise<void>
  beforeCommit: () => Promise<void>
}

export interface Delivery {
  line: string | null
  cursor: WatchCursor
}

export interface WatchArgs {
  pids: number[]
  once: boolean
  card?: number
}

export function parseWatchArgs(args: string[]): WatchArgs | undefined {
  const pids: number[] = []
  let afterPid = false
  let afterCard = false
  let once = false
  let card: number | undefined
  for (const arg of args) {
    if (afterCard) {
      if (card !== undefined || !/^[1-9]\d*$/.test(arg))
        return undefined
      card = Number(arg)
      afterCard = false
      continue
    }
    if (arg === ONCE) {
      once = true
      continue
    }
    if (arg === CARD) {
      afterCard = true
      afterPid = false
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
  if (afterCard || (afterPid && pids.length === 0) || (card !== undefined && !once))
    return undefined
  return card === undefined ? { pids, once } : { pids, once, card }
}

function journalCard(line: string): number | undefined {
  const task = (JSON.parse(line) as { task?: unknown }).task
  const id = typeof task === 'string' ? task.replace(/^#/, '') : typeof task === 'number' ? String(task) : ''
  return /^[1-9]\d*$/.test(id) ? Number(id) : undefined
}

export function busLine(event: BusEvent): string {
  return `bus ${event.type} card ${event.cardId ?? '-'} pr ${event.pr ?? '-'} ${event.payload}`
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

function turnsRed(state: Pick<WatchState, 'ciByPr'>, event: BusEvent): boolean {
  const before = state.ciByPr.get(event.pr)
  const now = { head: event.head, ci: ciOf(event.payload) }
  state.ciByPr.set(event.pr, now)
  return now.ci === FAILED_CI && (before?.ci !== FAILED_CI || before.head !== now.head)
}

export function wakesTheWindow(state: Pick<WatchState, 'ciByPr'>, event: BusEvent): boolean {
  if (!WAKING_BUS_EVENTS.includes(event.type))
    return false
  return event.type !== PR_OBSERVED || turnsRed(state, event)
}

function busLines(state: WatchState, deps: WatchDeps): string[] {
  const events = deps.busEventsAfter(state.busId)
  for (const event of events)
    state.busId = Math.max(state.busId, event.id)
  return events.filter(event => wakesTheWindow(state, event)).map(busLine)
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

function journalDelivery(cursor: WatchCursor, deps: WatchDeps, card: number | undefined): Delivery | undefined {
  const end = deps.size()
  if (end < cursor.offset)
    throw new WatchRefusal(`miko:watch: the journal ${deps.journal} is ${end} bytes, shorter than the cursor's offset ${cursor.offset}; it was cut or replaced`)
  const lines = deps.readFrom(cursor.offset, end).split('\n')
  lines.pop()
  let offset = cursor.offset
  let skipped: Delivery | undefined
  for (const line of lines) {
    offset += Buffer.byteLength(line) + 1
    if (wakingEvent(line) === undefined)
      continue
    if (card === undefined || journalCard(line) === card)
      return { line: `journal ${line}`, cursor: { ...cursor, offset } }
    skipped = { line: null, cursor: { ...cursor, offset } }
  }
  return skipped
}

function busDelivery(cursor: WatchCursor, deps: WatchDeps, card: number | undefined): Delivery | undefined {
  const end = deps.lastBusId()
  if (end < cursor.busId)
    throw new WatchRefusal(`miko:watch: the bus ${deps.bus} ends at event ${end}, before the cursor's event ${cursor.busId}; it was replaced or cut`)
  const seen = { ciByPr: new Map() as WatchState['ciByPr'] }
  for (const event of deps.observedUpTo(cursor.busId))
    seen.ciByPr.set(event.pr, { head: event.head, ci: ciOf(event.payload) })
  let skipped: Delivery | undefined
  for (const event of deps.busEventsAfter(cursor.busId)) {
    if (event.id > end)
      return skipped
    if (!wakesTheWindow(seen, event))
      continue
    if (card === undefined || event.cardId === card)
      return { line: busLine(event), cursor: { ...cursor, busId: event.id } }
    skipped = { line: null, cursor: { ...cursor, busId: event.id } }
  }
  return skipped
}

export function selectOnce(cursor: WatchCursor, deps: WatchDeps, pids: number[], card?: number): Delivery | undefined {
  const journal = journalDelivery(cursor, deps, card)
  if (journal?.line != null)
    return journal
  const afterJournal = journal?.cursor ?? cursor
  const bus = busDelivery(afterJournal, deps, card)
  if (bus?.line != null)
    return bus
  const afterSkips = bus?.cursor ?? afterJournal
  const exited = pids.find(pid => !deps.alive(pid))
  if (exited !== undefined)
    return { line: `pid ${exited} exited`, cursor: afterSkips }
  return afterSkips === cursor ? undefined : { line: null, cursor: afterSkips }
}

export async function deliverOnce(store: OnceStore, deps: WatchDeps, pids: number[], card?: number): Promise<void> {
  for (;;) {
    const delivery = selectOnce(store.cursor(), deps, pids, card)
    if (delivery?.line === null) {
      store.write(delivery.cursor)
      store.commit()
    }
    if (delivery?.line == null) {
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
      continue
    }
    try {
      await deps.emit(delivery.line)
    }
    catch (error) {
      throw new WatchRefusal(`miko:watch: the line could not be written to stdout (${(error as Error).message}); the cursor stays where it was`)
    }
    store.write(delivery.cursor)
    await deps.beforeCommit()
    store.commit()
    return
  }
}

function emitLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.once('error', reject)
    process.stdout.write(`${line}\n`, (error) => {
      if (error)
        reject(error)
      else
        resolve()
    })
  })
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

interface BusRow {
  id: number
  type: string
  card_id: number | null
  pr: number | null
  head: string | null
  payload: string
}

function eventOfRow(row: BusRow): BusEvent {
  return { id: Number(row.id), type: row.type, cardId: row.card_id === null ? null : Number(row.card_id), pr: row.pr === null ? null : Number(row.pr), head: row.head, payload: row.payload }
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
    const rows = db.prepare(`SELECT id, type, card_id, pr, head, payload FROM events WHERE type IN (${types}) AND id > ? ORDER BY id`).all(...WAKING_BUS_EVENTS, id) as unknown as BusRow[]
    return rows.map(eventOfRow)
  }
  finally {
    db.close()
  }
}

function observedUpTo(bus: string, id: number): BusEvent[] {
  const db = openBus(bus)
  try {
    const rows = db.prepare('SELECT id, type, card_id, pr, head, payload FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE type = ? AND id <= ? GROUP BY pr) ORDER BY id').all(PR_OBSERVED, id) as unknown as BusRow[]
    return rows.map(eventOfRow)
  }
  finally {
    db.close()
  }
}

function legacyCursor(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
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

export function productionDeps(handoff: string, bus: string): WatchDeps {
  const journal = path.join(handoff, GHOST_JOURNAL)
  return {
    journal,
    bus,
    size: () => sizeOf(journal),
    readFrom: (offset, end) => readFrom(journal, offset, end),
    lastBusId: () => lastBusId(bus),
    busEventsAfter: id => busEventsAfter(bus, id),
    observedUpTo: id => observedUpTo(bus, id),
    alive,
    emit: emitLine,
    beforeCommit: async () => {},
  }
}

export async function runOnce(handoff: string, deps: WatchDeps, pids: number[], card?: number): Promise<void> {
  const legacy = path.join(handoff, LEGACY_CURSOR)
  const store = OnceStore.open(path.join(handoff, ONCE_STORE), { file: legacy, text: legacyCursor(legacy) }, () => ({ offset: deps.size(), busId: deps.lastBusId() }))
  try {
    if (store.opened.kind === 'migrated')
      rmSync(legacy, { force: true })
    console.error(store.openedLine())
    console.error(WATCHING_FROM_CURSOR)
    await deliverOnce(store, deps, pids, card)
  }
  finally {
    store.close()
  }
}

async function watchForever(deps: WatchDeps, pids: number[]): Promise<void> {
  const state = watchState(deps, pids)
  console.error(WATCHING)
  for (;;) {
    for (const line of tick(state, deps))
      process.stdout.write(`${line}\n`)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseWatchArgs(process.argv.slice(2))
  if (args === undefined) {
    console.error(USAGE)
    process.exit(2)
  }
  const handoff = process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff')
  const deps = productionDeps(handoff, defaultBusPath())
  try {
    await (args.once ? runOnce(handoff, deps, args.pids, args.card) : watchForever(deps, args.pids))
  }
  catch (error) {
    if (!(error instanceof WatchRefusal))
      throw error
    console.error(error.message)
    process.exitCode = 1
  }
}

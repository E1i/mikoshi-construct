import type { WatchCursor } from './watch-store.js'
import type { WindowPr } from './window-prs.js'
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { PRIORITIES } from '../../src/card/parking.js'
import { IN_REVIEW_CARD, RUNNING_CARD, STOPPED_CARD } from '../core/card-automaton.js'
import { defaultBusPath, openBus } from '../core/db.js'
import { BUS_PULSE, CARD_CLOSED, CARD_STOPPED, CARD_WAITING, GHOST_LINE, MERGE_DONE, POLICY_DENIED, PR_CLOSED, PR_OBSERVED, PROCESS_JUDGED, REQUEST_DONE, REQUEST_REFUSED, REVIEW_RECORDED, TASK_EXPIRED, WINDOW_REQUEST, WITNESS_RECORDED, WORKER_DOWN } from '../core/events.js'
import { HANDOFF_DIR_VARIABLE } from '../core/handoff-dir.js'
import { HEARTBEAT_QUEUES, LEASE_EXPIRED } from '../core/lease.js'
import { REVIEW_ROUNDS_SPENT } from '../nodes/review/review-executor.js'
import { CARD_PROCESS } from '../supervisor/heartbeat.js'
import { WatchRefusal } from './watch-refusal.js'
import { ONCE_STORE, OnceStore } from './watch-store.js'
import { windowBeat, windowOf } from './window-heartbeat.js'
import { windowOpenPrs } from './window-prs.js'
import { requestActor } from './window-requests.js'

export const STOP_EVENT = 'relaunch-stop'
export const WAKING_EVENTS = ['merge', 'fall', 'relaunch-stop', 'stop']
export const WAKING_BUS_EVENTS = [GHOST_LINE, STOP_EVENT, REVIEW_RECORDED, MERGE_DONE, PR_CLOSED, CARD_CLOSED, PR_OBSERVED, REVIEW_ROUNDS_SPENT, CARD_STOPPED, CARD_WAITING, POLICY_DENIED, TASK_EXPIRED, WORKER_DOWN, PROCESS_JUDGED, REQUEST_REFUSED, REQUEST_DONE, WITNESS_RECORDED]
export const HEAD_BOUND_EVENTS = [STOP_EVENT, REVIEW_RECORDED, REVIEW_ROUNDS_SPENT, CARD_STOPPED]
export const FAILED_CI = 'red'
export const PASSED_CI = 'green'
export const RED_WITNESS = 'red'
export const GREEN_WITNESS = 'green'
export const DENIALS_IN_A_ROW = 2
export const USER_SETTINGS = '~/.claude/settings.json'
export const STALL_MS = 20 * 60_000
export const BUS_ALIVE_MS = 2 * 60_000
export const IN_FLIGHT_CARDS = [RUNNING_CARD, IN_REVIEW_CARD]
export const POLL_MS = 500
export const USAGE = 'usage: pnpm miko:watch [--once [--card <N>]]'
export const ONCE = '--once'
export const CARD = '--card'
export const WATCHING = 'miko:watch: what is already there is read; watching for what comes next'
export const WATCHING_FROM_CURSOR = 'miko:watch: reading from the --once cursor; watching'
export const LEGACY_CURSOR = 'miko-watch.json'
export const WOKEN_STALLS = 'miko-watch-stalls.json'

export function skippedLine(busId: number): string {
  return `skipped through bus id ${busId}`
}

export interface DenialRun {
  reason: string
  count: number
}

export interface WatchState {
  busId: number
  ciByPr: Map<number | null, { head: string | null, ci: unknown }>
  witnessByPr: Map<number | null, unknown>
  deniedByTask: Map<string, DenialRun>
  windowPrs: ReadonlySet<number>
  ownRequest: (request: number) => boolean
  stalls: Set<string>
  stuck: Set<string>
}

export interface CardActivity {
  cardId: number
  lastEventId: number
  lastType: string
  lastTs: string
}

export interface StuckPr {
  pr: number
  cardId: number
  head: string | null
  reason: string
  priority: string | null
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
  bus: string
  lastBusId: () => number
  busEventsAfter: (id: number) => BusEvent[]
  observedUpTo: (id: number) => BusEvent[]
  witnessedUpTo: (id: number) => BusEvent[]
  deniedUpTo: (id: number) => BusEvent[]
  windowPrs: () => ReadonlySet<number>
  ownRequest: (request: number) => boolean
  observedHeads: (pr: number) => string[]
  stalls: () => CardActivity[]
  stuck: () => StuckPr[]
  wokenStalls: () => ReadonlyMap<number, number>
  rememberStalls: (woken: readonly CardActivity[]) => void
  emit: (line: string) => Promise<void>
  beforeCommit: () => Promise<void>
  beat: () => void
}

export interface Delivery {
  line: string | null
  cursor: WatchCursor
}

export interface WatchArgs {
  once: boolean
  card?: number
}

export function parseWatchArgs(args: string[]): WatchArgs | undefined {
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
    if (arg !== CARD)
      return undefined
    afterCard = true
  }
  if (afterCard || (card !== undefined && !once))
    return undefined
  return card === undefined ? { once } : { once, card }
}

function ghostLineCard(payload: string): number | null {
  const task = payloadOf(payload).task
  const id = typeof task === 'string' ? task : ''
  return /^[1-9]\d*$/.test(id) ? Number(id) : null
}

export const ROUND_LIMIT_NEEDS_OWNER = 'round limit reached, the bus queues no further review; owner decision needed: allow-merge'

function payloadOf(payload: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(payload)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function textOf(payload: Record<string, unknown>, name: string): string | undefined {
  return typeof payload[name] === 'string' ? payload[name] : undefined
}

function denialReason(payload: Record<string, unknown>): string {
  return textOf(payload, 'reason') ?? textOf(payload, 'rule') ?? '-'
}

export function denialLine(payload: string): string {
  const parsed = payloadOf(payload)
  return `second in a row for one task: reason ${denialReason(parsed)}; settings ${textOf(parsed, 'settings') ?? USER_SETTINGS}`
}

export function busLine(event: BusEvent): string {
  const head = `bus ${event.type} card ${event.cardId ?? '-'} pr ${event.pr ?? '-'}`
  if (event.type === REVIEW_ROUNDS_SPENT)
    return `${head} ${ROUND_LIMIT_NEEDS_OWNER} ${event.payload}`
  if (event.type === POLICY_DENIED)
    return `${head} ${denialLine(event.payload)} ${event.payload}`
  return `${head} ${event.payload}`
}

export function stallKey(stall: CardActivity): string {
  return `${stall.cardId}:${stall.lastEventId}`
}

export function stallLine(stall: CardActivity, now: number): string {
  const minutes = Math.floor((now - Date.parse(stall.lastTs)) / 60_000)
  return `stall card ${stall.cardId}: no new event for ${minutes} minutes since ${stall.lastType} at ${stall.lastTs}, while the bus is alive`
}

export function stalledOf(cards: CardActivity[], lastPulseTs: string | undefined, now: number): CardActivity[] {
  if (lastPulseTs === undefined || now - Date.parse(lastPulseTs) > BUS_ALIVE_MS)
    return []
  return cards.filter(card => now - Date.parse(card.lastTs) > STALL_MS)
}

function stuckReason(open: WindowPr): string | null {
  if (open.ci === FAILED_CI)
    return 'red CI'
  return open.cardState === STOPPED_CARD ? 'card stopped' : null
}

function priorityRank(priority: string | null): number {
  const rank = (PRIORITIES as readonly (string | null)[]).indexOf(priority)
  return rank === -1 ? PRIORITIES.length : rank
}

export function stuckOf(open: WindowPr[]): StuckPr[] {
  return open
    .flatMap((each) => {
      const reason = stuckReason(each)
      return reason === null ? [] : [{ pr: each.pr, cardId: each.cardId, head: each.head, reason, priority: each.priority }]
    })
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.pr - b.pr)
}

export function stuckKey(stuck: StuckPr): string {
  return `${stuck.pr}:${stuck.head ?? '-'}:${stuck.reason}`
}

export function stuckLine(stuck: StuckPr): string {
  return `stuck PR #${stuck.pr} card ${stuck.cardId}: ${stuck.reason}, priority ${stuck.priority ?? '-'}; the window moves it before it takes a new card`
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

export function watchState(deps: WatchDeps): WatchState {
  const busId = deps.lastBusId()
  return { busId, ciByPr: new Map(), witnessByPr: new Map(), deniedByTask: denialsUpTo(deps, busId), windowPrs: deps.windowPrs(), ownRequest: deps.ownRequest, stalls: new Set(deps.stalls().map(stallKey)), stuck: new Set(deps.stuck().map(stuckKey)) }
}

function ciOf(payload: string): unknown {
  return payloadOf(payload).ci
}

function verdictOf(payload: string): unknown {
  return payloadOf(payload).verdict
}

type BusMemory = Pick<WatchState, 'ciByPr' | 'witnessByPr' | 'deniedByTask' | 'windowPrs' | 'ownRequest'>

function busMemoryUpTo(deps: WatchDeps, busId: number): BusMemory {
  const ciByPr: BusMemory['ciByPr'] = new Map(deps.observedUpTo(busId).map(event => [event.pr, { head: event.head, ci: ciOf(event.payload) }]))
  const witnessByPr: BusMemory['witnessByPr'] = new Map(deps.witnessedUpTo(busId).map(event => [event.pr, verdictOf(event.payload)]))
  return { ciByPr, witnessByPr, deniedByTask: denialsUpTo(deps, busId), windowPrs: deps.windowPrs(), ownRequest: deps.ownRequest }
}

function ciTurns(state: BusMemory, event: BusEvent): boolean {
  const before = state.ciByPr.get(event.pr)
  const now = { head: event.head, ci: ciOf(event.payload) }
  state.ciByPr.set(event.pr, now)
  const changed = before?.ci !== now.ci || before?.head !== now.head
  if (now.ci === FAILED_CI)
    return changed
  return now.ci === PASSED_CI && changed && event.pr !== null && state.windowPrs.has(event.pr)
}

function witnessTurns(state: BusMemory, event: BusEvent): boolean {
  const before = state.witnessByPr.get(event.pr)
  const now = verdictOf(event.payload)
  state.witnessByPr.set(event.pr, now)
  return now === RED_WITNESS || (now === GREEN_WITNESS && before === RED_WITNESS)
}

function answersOwnRequest(state: BusMemory, event: BusEvent): boolean {
  const request = payloadOf(event.payload).request
  return Number.isSafeInteger(request) && state.ownRequest(request as number)
}

function deniedTask(event: BusEvent, payload: Record<string, unknown>): string {
  return [event.cardId ?? '-', event.pr ?? '-', event.head ?? '-', textOf(payload, 'command') ?? '-'].join(':')
}

function deniedAgainInARow(state: Pick<BusMemory, 'deniedByTask'>, event: BusEvent): boolean {
  const payload = payloadOf(event.payload)
  const task = deniedTask(event, payload)
  const reason = denialReason(payload)
  const before = state.deniedByTask.get(task)
  const count = before?.reason === reason ? before.count + 1 : 1
  state.deniedByTask.set(task, { reason, count })
  return count === DENIALS_IN_A_ROW
}

function denialsUpTo(deps: WatchDeps, busId: number): Map<string, DenialRun> {
  const seen: Pick<BusMemory, 'deniedByTask'> = { deniedByTask: new Map() }
  for (const event of deps.deniedUpTo(busId))
    deniedAgainInARow(seen, event)
  return seen.deniedByTask
}

export function wakesTheWindow(state: BusMemory, event: BusEvent): boolean {
  if (!WAKING_BUS_EVENTS.includes(event.type))
    return false
  if (event.type === PR_OBSERVED)
    return ciTurns(state, event)
  if (event.type === WITNESS_RECORDED)
    return witnessTurns(state, event)
  if (event.type === REQUEST_DONE)
    return answersOwnRequest(state, event)
  if (event.type === POLICY_DENIED)
    return deniedAgainInARow(state, event)
  if (event.type === TASK_EXPIRED)
    return sessionLeaseLapsed(payloadOf(event.payload))
  if (event.type === GHOST_LINE)
    return wakingEvent(event.payload) !== undefined
  return true
}

function sessionLeaseLapsed(payload: Record<string, unknown>): boolean {
  const queue = textOf(payload, 'queue')
  return textOf(payload, 'reason') === LEASE_EXPIRED && queue !== undefined && (HEARTBEAT_QUEUES as readonly string[]).includes(queue)
}

export function ofSupersededHead(event: BusEvent, deps: Pick<WatchDeps, 'observedHeads'>): boolean {
  if (!HEAD_BOUND_EVENTS.includes(event.type) || event.pr === null || event.head === null)
    return false
  const heads = deps.observedHeads(event.pr)
  const current = heads.at(-1)
  return current !== undefined && current !== event.head && heads.includes(event.head)
}

function busLines(state: WatchState, deps: WatchDeps): string[] {
  state.windowPrs = deps.windowPrs()
  const events = deps.busEventsAfter(state.busId)
  for (const event of events)
    state.busId = Math.max(state.busId, event.id)
  return events.filter(event => wakesTheWindow(state, event) && !ofSupersededHead(event, deps)).map(busLine)
}

function newStalls(known: Set<string>, deps: WatchDeps): CardActivity[] {
  const fresh = deps.stalls().filter(stall => !known.has(stallKey(stall)))
  for (const stall of fresh)
    known.add(stallKey(stall))
  return fresh
}

function newStuck(known: Set<string>, deps: WatchDeps): StuckPr[] {
  const fresh = deps.stuck().filter(stuck => !known.has(stuckKey(stuck)))
  for (const stuck of fresh)
    known.add(stuckKey(stuck))
  return fresh
}

export function tick(state: WatchState, deps: WatchDeps, now = Date.now()): string[] {
  const stuck = newStuck(state.stuck, deps).map(stuckLine)
  const stalls = newStalls(state.stalls, deps).map(stall => stallLine(stall, now))
  return [...busLines(state, deps), ...stuck, ...stalls]
}

export function cardOfEvent(event: BusEvent): number | null {
  if (event.cardId === null && event.type === GHOST_LINE)
    return ghostLineCard(event.payload)
  if (event.cardId !== null || event.type !== PROCESS_JUDGED)
    return event.cardId
  const name = textOf(payloadOf(event.payload), 'process') ?? ''
  const id = name.startsWith(CARD_PROCESS) ? name.slice(CARD_PROCESS.length) : ''
  return /^[1-9]\d*$/.test(id) ? Number(id) : null
}

export function selectOnce(cursor: WatchCursor, deps: WatchDeps, card?: number): Delivery | undefined {
  const end = deps.lastBusId()
  if (end < cursor.busId)
    throw new WatchRefusal(`miko:watch: the bus ${deps.bus} ends at event ${end}, before the cursor's event ${cursor.busId}; it was replaced or cut`)
  const seen = busMemoryUpTo(deps, cursor.busId)
  let skipped: Delivery | undefined
  for (const event of deps.busEventsAfter(cursor.busId)) {
    if (event.id > end)
      return skipped
    if (!wakesTheWindow(seen, event))
      continue
    if (!ofSupersededHead(event, deps) && (card === undefined || cardOfEvent(event) === card))
      return { line: busLine(event), cursor: { ...cursor, busId: event.id } }
    skipped = { line: null, cursor: { ...cursor, busId: event.id } }
  }
  return skipped
}

function wokenBefore(woken: ReadonlyMap<number, number>, stall: CardActivity): boolean {
  return stall.lastEventId <= (woken.get(stall.cardId) ?? 0)
}

interface StuckLines {
  text: string
  stalled: CardActivity[]
}

function stuckLines(known: Set<string>, deps: WatchDeps, card: number | undefined, now: number): StuckLines | undefined {
  const ofCard = (cardId: number): boolean => card === undefined || cardId === card
  const stuck = deps.stuck().filter(each => !known.has(stuckKey(each)) && ofCard(each.cardId))
  const woken = deps.wokenStalls()
  const stalled = deps.stalls().filter(stall => !wokenBefore(woken, stall) && ofCard(stall.cardId))
  for (const each of stuck)
    known.add(stuckKey(each))
  const lines = [...stuck.map(stuckLine), ...stalled.map(stall => stallLine(stall, now))]
  return lines.length === 0 ? undefined : { text: lines.join('\n'), stalled }
}

export async function deliverOnce(store: OnceStore, deps: WatchDeps, card?: number, now: () => number = Date.now): Promise<void> {
  const knownStuck = new Set(deps.stuck().map(stuckKey))
  for (;;) {
    deps.beat()
    const cursor = store.cursor()
    const selected = selectOnce(cursor, deps, card)
    if (selected?.line === null) {
      store.write(selected.cursor)
      store.commit()
      console.error(skippedLine(selected.cursor.busId))
    }
    const stuck = selected?.line == null ? stuckLines(knownStuck, deps, card, now()) : undefined
    const delivery = stuck === undefined ? selected : { line: stuck.text, cursor: store.cursor() }
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
    if (stuck !== undefined && stuck.stalled.length > 0)
      deps.rememberStalls(stuck.stalled)
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

function witnessedUpTo(bus: string, id: number): BusEvent[] {
  const db = openBus(bus)
  try {
    const rows = db.prepare('SELECT id, type, card_id, pr, head, payload FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE type = ? AND id <= ? GROUP BY pr) ORDER BY id').all(WITNESS_RECORDED, id) as unknown as BusRow[]
    return rows.map(eventOfRow)
  }
  finally {
    db.close()
  }
}

function windowPrs(bus: string): ReadonlySet<number> {
  const db = openBus(bus)
  try {
    return new Set(windowOpenPrs(db).map(open => open.pr))
  }
  finally {
    db.close()
  }
}

function ownRequest(bus: string, actor: string, request: number): boolean {
  const db = openBus(bus)
  try {
    return db.prepare('SELECT 1 FROM events WHERE id = ? AND type = ? AND actor = ?').get(request, WINDOW_REQUEST, actor) !== undefined
  }
  finally {
    db.close()
  }
}

function deniedUpTo(bus: string, id: number): BusEvent[] {
  const db = openBus(bus)
  try {
    const rows = db.prepare('SELECT id, type, card_id, pr, head, payload FROM events WHERE type = ? AND id <= ? ORDER BY id').all(POLICY_DENIED, id) as unknown as BusRow[]
    return rows.map(eventOfRow)
  }
  finally {
    db.close()
  }
}

function observedHeads(bus: string, pr: number): string[] {
  const db = openBus(bus)
  try {
    const rows = db.prepare('SELECT head FROM events WHERE type = ? AND pr = ? AND head IS NOT NULL GROUP BY head ORDER BY MAX(id)').all(PR_OBSERVED, pr) as unknown as Array<{ head: string }>
    return rows.map(row => row.head)
  }
  finally {
    db.close()
  }
}

interface ActivityRow {
  card_id: number
  id: number
  type: string
  ts: string
}

function stalls(bus: string, now: number): CardActivity[] {
  const db = openBus(bus)
  try {
    const pulse = db.prepare('SELECT ts FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(BUS_PULSE) as { ts: string } | undefined
    const states = IN_FLIGHT_CARDS.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT card_id, id, type, ts FROM events WHERE id IN (
        SELECT MAX(event.id) FROM events AS event JOIN cards AS card ON card.card_id = event.card_id
        WHERE card.state IN (${states}) AND event.id >= (SELECT COALESCE(MIN(event_id), 0) FROM cards WHERE state IN (${states}))
        GROUP BY event.card_id
      ) ORDER BY id
    `).all(...IN_FLIGHT_CARDS, ...IN_FLIGHT_CARDS) as unknown as ActivityRow[]
    const cards = rows.map(row => ({ cardId: Number(row.card_id), lastEventId: Number(row.id), lastType: row.type, lastTs: row.ts }))
    return stalledOf(cards, pulse?.ts, now)
  }
  finally {
    db.close()
  }
}

function stuckPrs(bus: string): StuckPr[] {
  const db = openBus(bus)
  try {
    return stuckOf(windowOpenPrs(db))
  }
  finally {
    db.close()
  }
}

function legacyCursor(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

export function parseWokenStalls(text: string): Map<number, number> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return undefined
    const entries = Object.entries(parsed as Record<string, unknown>)
    if (!entries.every(([card, id]) => /^[1-9]\d*$/.test(card) && Number.isSafeInteger(id) && (id as number) > 0))
      return undefined
    return new Map(entries.map(([card, id]) => [Number(card), id as number]))
  }
  catch {
    return undefined
  }
}

function readWokenStalls(file: string): Map<number, number> {
  if (!existsSync(file))
    return new Map()
  const text = readFileSync(file, 'utf8')
  const woken = parseWokenStalls(text)
  if (woken === undefined)
    throw new WatchRefusal(`miko:watch: ${file} is not {"<card>": <last event id it woke on>}: ${JSON.stringify(text.slice(0, 200))}`)
  return woken
}

export function withWoken(woken: ReadonlyMap<number, number>, stalls: readonly CardActivity[]): Map<number, number> {
  const next = new Map(woken)
  for (const stall of stalls)
    next.set(stall.cardId, Math.max(next.get(stall.cardId) ?? 0, stall.lastEventId))
  return next
}

function rememberStalls(file: string, stalls: readonly CardActivity[]): void {
  const next = withWoken(readWokenStalls(file), stalls)
  const draft = `${file}.draft`
  writeFileSync(draft, `${JSON.stringify(Object.fromEntries([...next].sort((a, b) => a[0] - b[0])))}\n`)
  renameSync(draft, file)
}

export function productionDeps(handoff: string, bus: string): WatchDeps {
  const woken = path.join(handoff, WOKEN_STALLS)
  const actor = requestActor(process.env)
  return {
    bus,
    lastBusId: () => lastBusId(bus),
    busEventsAfter: id => busEventsAfter(bus, id),
    observedUpTo: id => observedUpTo(bus, id),
    witnessedUpTo: id => witnessedUpTo(bus, id),
    deniedUpTo: id => deniedUpTo(bus, id),
    windowPrs: () => windowPrs(bus),
    ownRequest: request => ownRequest(bus, actor, request),
    observedHeads: pr => observedHeads(bus, pr),
    stalls: () => stalls(bus, Date.now()),
    stuck: () => stuckPrs(bus),
    wokenStalls: () => readWokenStalls(woken),
    rememberStalls: stalls => rememberStalls(woken, stalls),
    emit: emitLine,
    beforeCommit: async () => {},
    beat: windowBeat(bus, windowOf(process.env), Date.now),
  }
}

export async function runOnce(handoff: string, deps: WatchDeps, card?: number): Promise<void> {
  const legacy = path.join(handoff, LEGACY_CURSOR)
  const store = OnceStore.open(path.join(handoff, ONCE_STORE), { file: legacy, text: legacyCursor(legacy) }, () => ({ offset: 0, busId: deps.lastBusId() }))
  try {
    if (store.opened.kind === 'migrated')
      rmSync(legacy, { force: true })
    console.error(store.openedLine())
    console.error(WATCHING_FROM_CURSOR)
    await deliverOnce(store, deps, card)
  }
  finally {
    store.close()
  }
}

async function watchForever(deps: WatchDeps): Promise<void> {
  const state = watchState(deps)
  console.error(WATCHING)
  for (;;) {
    deps.beat()
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
    await (args.once ? runOnce(handoff, deps, args.card) : watchForever(deps))
  }
  catch (error) {
    if (!(error instanceof WatchRefusal))
      throw error
    console.error(error.message)
    process.exitCode = 1
  }
}

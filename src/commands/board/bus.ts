import type { BusDb } from '../cost/bus.js'
import type { Goal } from './goal.js'
import { existsSync } from 'node:fs'
import { BUS_PULSE, CARD_FELL, CARD_STOPPED, CARD_VERIFIED, CHECKS_MATRIX_EVENT, LANE_ASSIGNED, PROCESS_HEARTBEAT, SESSION_HEARTBEAT, WINDOW_SUBAGENT_EVENT } from '../../../scripts/core/events.js'
import { withReadOnlyBus } from '../cost/bus.js'
import { goalOf } from './goal.js'

export const SESSION_DEATH_KEY = `${CARD_STOPPED}:session-end:`
export const SHORT_SHA = 7
export const SUBAGENT_SHOWN_HOURS = 12
export const SESSION_SHOWN_MINUTES = 10
export const FLOW_STATES = [['queued'], ['running', 'changes'], ['in_review'], ['ready']]
export const LIVE_STATES = FLOW_STATES.flat()
export const CARD_STAGES = ['planned', 'in work', 'review', 'answer/changes', 'ready', 'merged', 'stopped', 'dropped'] as const
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

export type CardStage = typeof CARD_STAGES[number]

const STAGE_OF_STATE: Readonly<Record<string, CardStage>> = {
  queued: 'planned',
  running: 'in work',
  in_review: 'review',
  changes: 'answer/changes',
  ready: 'ready',
  merged: 'merged',
  stopped: 'stopped',
  dropped: 'dropped',
  closed: 'dropped',
}
const STAGE_OF_QUEUE: Readonly<Record<string, CardStage>> = { review: 'review', answer: 'answer/changes', merge: 'ready' }
const STAGE_OF_STEP: Readonly<Record<string, CardStage>> = { ...STAGE_OF_QUEUE, launch: 'in work' }
const SETTLED_STATES = new Set(['merged', 'stopped', 'dropped', 'closed'])

const LANELESS_STATES = ['merged', 'dropped', 'closed']
const OPEN_TASK_STATES = ['queued', 'leased']

export interface BusCard {
  id: number
  state: string | null
  stage: CardStage
  lane: string | null
  line: string | null
  since: string | null
  body: boolean
  closed: boolean
  closedAt: string | null
}

export interface CardsAtStage {
  stage: CardStage
  cards: number[]
}

export type OwnerWaitNeed = 'decision' | 'merge' | 'command'

export interface OwnerWait {
  id: string
  need: OwnerWaitNeed
  text: string
  command: string | null
  card: number | null
  pr: number | null
  since: string
}

export interface BusService {
  role: string
  task: string
  tree: string | null
  step: string
}

export interface BusMatrix {
  pr: number
  head: string | null
  full: string | null
  killed: number
  survived: number
  notRun: number
}

export interface BusSlot {
  queue: string
  used: number
  total: number | null
}

export interface BusFacts {
  at: string
  goal: Goal | null
  waits: OwnerWait[]
  pulse: string | null
  slots: BusSlot[]
  cards: BusCard[]
  services: BusService[]
  matrices: BusMatrix[]
  failure: string | null
  reviewQueue: number
  lanes: number | null
}

export type BusReading
  = | { status: 'read', file: string, facts: BusFacts }
    | { status: 'absent', file: string }
    | { status: 'unreadable', file: string, reason: string }

export type BusReader = () => BusReading

interface TaskRow {
  queue: string
  card_id: number
  head: string | null
  verdict: string | null
}

interface EventRow {
  id: number
  ts: string | null
  type: string
  card_id: number | null
  pr: number | null
  dedupe_key: string | null
  legacy: number
  payload: string
}

interface CardRow {
  id: number
  state: string | null
  pr: number | null
  lane: string | null
  line: string | null
  since: string | null
  body: number
}

interface RoleRow {
  role: string
  status: string
  state: string
}

function payloadOf(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function stepOf(row: TaskRow): string {
  if (row.queue === 'review')
    return `review ${row.verdict ?? 'pending'}`
  return row.head === null ? row.queue : `${row.queue} ${row.head.slice(0, SHORT_SHA)}`
}

function taskServices(db: BusDb): BusService[] {
  const rows = db.prepare(`
    SELECT tasks.queue, tasks.card_id, tasks.head, prs.verdict_on_head AS verdict
    FROM tasks LEFT JOIN prs ON prs.pr = tasks.pr
    WHERE tasks.state = 'leased'
    ORDER BY tasks.id
  `).all() as unknown as TaskRow[]
  return rows.map(row => ({ role: row.queue, task: `#${row.card_id}`, tree: null, step: stepOf(row) }))
}

function isSilent(row: EventRow, now: Date): boolean {
  const at = row.ts === null ? Number.NaN : Date.parse(row.ts)
  return Number.isNaN(at) || now.getTime() - at > SUBAGENT_SHOWN_HOURS * HOUR_MS
}

function windowRoles(db: BusDb): BusService[] {
  const rows = db.prepare('SELECT role, status, state FROM roles ORDER BY role').all() as unknown as RoleRow[]
  return rows.map(row => ({ role: 'window', task: row.role, tree: null, step: `${row.state} · ${row.status}` }))
}

const BOARD_EVENT_TYPES = [WINDOW_SUBAGENT_EVENT, SESSION_HEARTBEAT, CARD_FELL, CARD_STOPPED, CARD_VERIFIED]

interface BoardEvents {
  of: (type: string) => EventRow[]
}

function boardEvents(db: BusDb): BoardEvents {
  const rows = db.prepare(`SELECT id, ts, type, card_id, pr, dedupe_key, legacy, payload FROM events WHERE type IN (${BOARD_EVENT_TYPES.map(() => '?').join(', ')}) ORDER BY id`).all(...BOARD_EVENT_TYPES) as unknown as EventRow[]
  return { of: type => rows.filter(row => row.type === type) }
}

function windowServices(events: BoardEvents, now: Date): BusService[] {
  const running = new Map<string, BusService>()
  for (const row of events.of(WINDOW_SUBAGENT_EVENT)) {
    const payload = payloadOf(row.payload)
    const role = text(payload.role) ?? 'agent'
    const task = text(payload.task) ?? '—'
    const session = text(payload.session) ?? `${role}:${task}`
    if (payload.phase === 'ended' || isSilent(row, now))
      running.delete(session)
    else
      running.set(session, { role, task, tree: text(payload.tree), step: text(payload.step) ?? 'started' })
  }
  return [...running.values()]
}

interface MatrixRow {
  pr: number
  head: string | null
  payload: string
}

function checkMatrices(db: BusDb): BusMatrix[] {
  const rows = db.prepare('SELECT pr, head, payload FROM events WHERE type = ? AND pr IS NOT NULL ORDER BY id').all(CHECKS_MATRIX_EVENT) as unknown as MatrixRow[]
  const latest = new Map<number, BusMatrix>()
  for (const row of rows) {
    const payload = payloadOf(row.payload)
    latest.set(row.pr, { pr: row.pr, head: row.head, full: text(payload.full), killed: count(payload.killed), survived: count(payload.survived), notRun: count(payload.notRun) })
  }
  return [...latest.values()].sort((a, b) => a.pr - b.pr)
}

function minutesAgo(ts: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(ts)) / MINUTE_MS))
}

function isFinished(card: BusCard): boolean {
  return card.closed || card.state === 'merged' || card.state === 'closed'
}

interface SessionBeat {
  row: EventRow
  step: string
}

function isFresh(ts: string | null, now: Date): ts is string {
  return ts !== null && now.getTime() - Date.parse(ts) <= SESSION_SHOWN_MINUTES * MINUTE_MS
}

function stepMatchesStage(step: string, card: BusCard | undefined): boolean {
  const named = STAGE_OF_STEP[step.split(' ')[0]!]
  return named === undefined || card === undefined || named === card.stage
}

function sessionServices(events: BoardEvents, cards: BusCard[], now: Date): BusService[] {
  const byId = new Map(cards.map(card => [card.id, card] as const))
  const latest = new Map<string, SessionBeat>()
  for (const row of events.of(SESSION_HEARTBEAT)) {
    const payload = payloadOf(row.payload)
    latest.set(text(payload.session) ?? `#${row.card_id ?? '?'}`, { row, step: text(payload.step) ?? 'session' })
  }
  return [...latest.values()].flatMap(({ row, step }) => {
    const card = row.card_id === null ? undefined : byId.get(row.card_id)
    if (!isFresh(row.ts, now) || (card !== undefined && isFinished(card)) || !stepMatchesStage(step, card))
      return []
    return [{ role: step.split(' ')[0]!, task: `#${row.card_id ?? '?'}`, tree: null, step: `${step} · pulse ${minutesAgo(row.ts, now)} min ago` }]
  })
}

const FAULT_REASON = 'fault'

function isSessionDeath(row: EventRow): boolean {
  return (row.dedupe_key ?? '').startsWith(SESSION_DEATH_KEY)
}

function isFailure(row: EventRow): boolean {
  return row.type === CARD_FELL || isSessionDeath(row) || payloadOf(row.payload).reason === FAULT_REASON
}

function failureOf(row: EventRow): string {
  if (row.type === CARD_FELL)
    return 'fell'
  return isSessionDeath(row) ? 'lost its session' : 'stopped on a fault'
}

function lastFailure(events: BoardEvents): string | null {
  const row = [...events.of(CARD_FELL), ...events.of(CARD_STOPPED)].filter(isFailure).sort((a, b) => b.id - a.id)[0]
  if (row === undefined)
    return null
  return `card #${row.card_id ?? '?'} ${failureOf(row)}${row.ts === null ? '' : ` at ${row.ts}`}`
}

function openQueues(db: BusDb): Map<number, string> {
  const rows = db.prepare(`SELECT card_id, queue FROM tasks WHERE state IN (${OPEN_TASK_STATES.map(() => '?').join(', ')}) ORDER BY id`).all(...OPEN_TASK_STATES) as unknown as { card_id: number, queue: string }[]
  return new Map(rows.filter(row => STAGE_OF_QUEUE[row.queue] !== undefined).map(row => [row.card_id, row.queue] as const))
}

function stageOf(state: string | null, closed: boolean, queue: string | undefined): CardStage {
  if (state !== null && SETTLED_STATES.has(state))
    return STAGE_OF_STATE[state]!
  if (closed)
    return 'merged'
  return (queue === undefined ? undefined : STAGE_OF_QUEUE[queue]) ?? STAGE_OF_STATE[state ?? ''] ?? 'planned'
}

function laneCountOf(db: BusDb): number | null {
  const row = db.prepare(`SELECT json_extract(payload, '$.lanes') AS lanes FROM events WHERE legacy = 0 AND type = ? ORDER BY id DESC LIMIT 1`).get(LANE_ASSIGNED) as { lanes: unknown } | undefined
  return typeof row?.lanes === 'number' && Number.isSafeInteger(row.lanes) && row.lanes > 0 ? row.lanes : null
}

function cardsOf(db: BusDb, events: BoardEvents): BusCard[] {
  const rows = db.prepare(`
    SELECT c.card_id AS id, c.state, c.pr, b.card_line AS line, e.ts AS since, b.card_id IS NOT NULL AS body,
      CASE WHEN c.state IN (${LANELESS_STATES.map(() => '?').join(', ')}) THEN NULL ELSE (
        SELECT json_extract(a.payload, '$.lane') FROM events a WHERE a.legacy = 0 AND a.type = ? AND a.card_id = c.card_id ORDER BY a.id DESC LIMIT 1
      ) END AS lane
    FROM cards c LEFT JOIN card_bodies b ON b.card_id = c.card_id LEFT JOIN events e ON e.id = c.event_id
    ORDER BY c.card_id
  `).all(...LANELESS_STATES, LANE_ASSIGNED) as unknown as CardRow[]
  const closed = new Map(events.of(CARD_VERIFIED).filter(row => row.legacy === 0).map(row => [row.card_id, row.ts] as const))
  const queues = openQueues(db)
  return rows.map(row => ({ id: row.id, state: row.state, stage: stageOf(row.state, closed.has(row.id), queues.get(row.id)), lane: row.lane, line: row.line, since: row.since, body: Boolean(row.body), closed: closed.has(row.id), closedAt: closed.get(row.id) ?? null }))
}

const OWNER_WAITS_TABLE = `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'owner_waits'`

const OPEN_OWNER_WAITS = `
  SELECT id, need, text, command, card_id AS card, pr, opened_at AS since FROM owner_waits
  WHERE state = 'open' ORDER BY CAST(substr(id, 2) AS INTEGER)
`

function ownerWaits(db: BusDb): OwnerWait[] {
  if (db.prepare(OWNER_WAITS_TABLE).get() === undefined)
    return []
  return (db.prepare(OPEN_OWNER_WAITS).all() as unknown as OwnerWait[]).map(row => ({ ...row }))
}

function lastPulse(db: BusDb): string | null {
  const row = db.prepare('SELECT ts FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(BUS_PULSE) as { ts: string | null } | undefined
  return row?.ts ?? null
}

const LAST_NODE_CAPACITY = `
  SELECT json_extract(payload, '$.queue') AS queue, json_extract(payload, '$.slots') AS slots FROM events
  WHERE id IN (
    SELECT max(id) FROM events WHERE type = ? AND legacy = 0 AND json_valid(payload) AND json_type(payload, '$.queue') = 'text'
    GROUP BY json_extract(payload, '$.queue')
  )
`

function nodeCapacity(db: BusDb): Map<string, number> {
  const rows = db.prepare(LAST_NODE_CAPACITY).all(PROCESS_HEARTBEAT) as unknown as { queue: string, slots: unknown }[]
  return new Map(rows.flatMap(row => typeof row.slots === 'number' && Number.isSafeInteger(row.slots) && row.slots > 0 ? [[row.queue, row.slots] as const] : []))
}

function slotsOf(db: BusDb): BusSlot[] {
  const used = new Map((db.prepare(`SELECT queue, count(*) AS used FROM tasks WHERE state = 'leased' GROUP BY queue`).all() as unknown as { queue: string, used: number }[]).map(row => [row.queue, Number(row.used)] as const))
  const capacity = nodeCapacity(db)
  return [...new Set([...used.keys(), ...capacity.keys()])].sort().map(queue => ({ queue, used: used.get(queue) ?? 0, total: capacity.get(queue) ?? null }))
}

export interface BusTask {
  id: number
  queue: string
  card: number
  pr: number | null
  head: string | null
  state: string
}

export interface BusCardEvent {
  id: number
  ts: string | null
  type: string
  pr: number | null
}

const OPEN_TASKS = `SELECT id, queue, card_id AS card, pr, head, state FROM tasks WHERE state IN (${OPEN_TASK_STATES.map(() => '?').join(', ')}) ORDER BY id`

const LATEST_CARD_EVENTS = `
  SELECT id, ts, type, card_id AS card, pr FROM (
    SELECT id, ts, type, card_id, pr, row_number() OVER (PARTITION BY card_id ORDER BY id DESC) AS rank FROM events WHERE card_id IS NOT NULL
  ) WHERE rank <= ? ORDER BY card_id, id
`

export function openTasks(db: BusDb): BusTask[] {
  return (db.prepare(OPEN_TASKS).all(...OPEN_TASK_STATES) as unknown as BusTask[]).map(task => ({ ...task }))
}

export function latestCardEvents(db: BusDb, perCard: number): Map<number, BusCardEvent[]> {
  const events = new Map<number, BusCardEvent[]>()
  for (const { card, ...event } of db.prepare(LATEST_CARD_EVENTS).all(perCard) as unknown as (BusCardEvent & { card: number })[])
    events.set(card, [...events.get(card) ?? [], event])
  return events
}

export function busFacts(db: BusDb, now: Date): BusFacts {
  const queue = db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'review' AND state IN ('queued', 'leased')`).get() as { n: number }
  const events = boardEvents(db)
  const cards = cardsOf(db, events)
  return {
    at: now.toISOString(),
    goal: goalOf(db, now),
    waits: ownerWaits(db),
    pulse: lastPulse(db),
    slots: slotsOf(db),
    cards,
    services: [...windowRoles(db), ...taskServices(db), ...windowServices(events, now), ...sessionServices(events, cards, now)],
    matrices: checkMatrices(db),
    failure: lastFailure(events),
    reviewQueue: Number(queue.n),
    lanes: laneCountOf(db),
  }
}

export function busReaderAt(file: string, clock: () => Date = () => new Date()): BusReader {
  return () => {
    if (!existsSync(file))
      return { status: 'absent', file }
    try {
      return { status: 'read', file, facts: withReadOnlyBus(file, db => busFacts(db, clock())) }
    }
    catch (error) {
      return { status: 'unreadable', file, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

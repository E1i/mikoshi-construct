import type { OwnerWait } from '../../../scripts/core/bus-readings.js'
import type { BusDb } from '../cost/bus.js'
import type { Goal } from './goal.js'
import { existsSync } from 'node:fs'
import { behindLine, CARDS, currentLane, lastReducedOwnerWaits, readLastReduced } from '../../../scripts/core/bus-readings.js'
import { BUS_PULSE, CARD_ADMITTED, CARD_FELL, CARD_STOPPED, CARD_VERIFIED, CHECKS_MATRIX_EVENT, PROCESS_HEARTBEAT, SESSION_HEARTBEAT, SLICE_PARENTS_BACKFILLED, TERMINAL_LANES, WINDOW_HEARTBEAT, WINDOW_SUBAGENT_EVENT } from '../../../scripts/core/events.js'
import { PLAIN_LORE } from '../../ui/lore.js'
import { withReadOnlyBus } from '../cost/bus.js'
import { goalOf } from './goal.js'

export const SESSION_DEATH_KEY = `${CARD_STOPPED}:session-end:`
export const SHORT_SHA = 7
export const SUBAGENT_SHOWN_HOURS = 12
export const SESSION_SHOWN_MINUTES = 10
export const LIVE_STATES = ['queued', 'running', 'changes', 'in_review', 'ready', 'stopped']
export const CARD_STAGES = ['planned', 'in work', 'review', 'answer/changes', 'ready', 'merged', 'stopped', 'dropped'] as const
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

export type CardStage = typeof CARD_STAGES[number]

export const FLOW_STAGES: readonly (readonly CardStage[])[] = [['planned'], ['in work', 'answer/changes'], ['review'], ['ready']]
export const LIVE_STAGES: readonly CardStage[] = FLOW_STAGES.flat()

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

const LANELESS_STATES = new Set(['merged', 'dropped', 'closed'])
const LEASED = 'leased'
const OPEN_TASK_STATES = ['queued', LEASED]

export interface SliceParent {
  card: number
  part: number
  of: number
}

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
  parent?: SliceParent
}

export interface CardsAtStage {
  stage: CardStage
  cards: number[]
}

export type { OwnerWait, OwnerWaitNeed } from '../../../scripts/core/bus-readings.js'

export interface ServiceGauges {
  context: number | null
  spent: number | null
  model: string | null
}

export interface SubagentReading {
  name: string
  context: number | null
  spent: number | null
  at: string | null
}

export interface BusService {
  role: string
  task: string
  tree: string | null
  step: string
  session?: string
  gauges?: ServiceGauges
  subagents?: SubagentReading[]
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
  waitsStale?: string
  cardsStale?: string
  pulse: string | null
  slots: BusSlot[]
  cards: BusCard[]
  services: BusService[]
  matrices: BusMatrix[]
  failure: string | null
  reviewQueue: number
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
  line: string | null
  since: string | null
  body: number
  admitted_parent: string | null
  backfilled_parent: string | null
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

const WINDOW_SUBAGENT_AGENT_KEY = /^(.+):(?:started|ended)$/

interface WindowAgents {
  session: string | null
  agents: SubagentReading[]
}

function runningWindowAgents(events: BoardEvents, now: Date): WindowAgents {
  const running = new Map<string, { session: string | null, reading: SubagentReading }>()
  for (const row of events.of(WINDOW_SUBAGENT_EVENT)) {
    const payload = payloadOf(row.payload)
    const role = text(payload.role) ?? 'agent'
    const session = text(payload.session)
    const agent = row.dedupe_key?.match(WINDOW_SUBAGENT_AGENT_KEY)?.[1] ?? session ?? `${role}:${text(payload.task) ?? '—'}`
    if (payload.phase === 'ended' || isSilent(row, now))
      running.delete(agent)
    else
      running.set(agent, { session, reading: { name: role, context: null, spent: null, at: row.ts } })
  }
  const live = [...running.values()]
  return { session: live.at(-1)?.session ?? null, agents: live.map(each => each.reading) }
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function subagentReadings(value: unknown): SubagentReading[] {
  return (Array.isArray(value) ? value as unknown[] : []).flatMap((entry) => {
    if (entry === null || typeof entry !== 'object')
      return []
    const reading = entry as Record<string, unknown>
    const name = text(reading.name)
    return name === null ? [] : [{ name, context: positiveOrNull(reading.context), spent: positiveOrNull(reading.spent), at: text(reading.at) }]
  })
}

function lastWindowBeat(db: BusDb, now: Date): { session: string | null, subagents: SubagentReading[] } {
  const row = db.prepare('SELECT id, ts, type, card_id, pr, dedupe_key, legacy, payload FROM events WHERE type = ? AND legacy = 0 ORDER BY id DESC LIMIT 1').get(WINDOW_HEARTBEAT) as unknown as EventRow | undefined
  if (row === undefined || isSilent(row, now))
    return { session: null, subagents: [] }
  const payload = payloadOf(row.payload)
  return { session: text(payload.session), subagents: subagentReadings(payload.subagents) }
}

const WINDOW_TILE_ROLE = 'window'
const WINDOW_TILE_TASK = 'miko'

function windowTiles(db: BusDb, events: BoardEvents, now: Date): BusService[] {
  const tiles = windowRoles(db)
  const beat = lastWindowBeat(db, now)
  const measured = new Set(beat.subagents.map(reading => reading.name))
  const running = runningWindowAgents(events, now)
  const subagents = [...beat.subagents, ...running.agents.filter(agent => !measured.has(agent.name))]
  if (subagents.length === 0)
    return tiles
  const held = tiles.find(tile => tile.task === WINDOW_TILE_TASK) ?? tiles[0] ?? { role: WINDOW_TILE_ROLE, task: WINDOW_TILE_TASK, tree: null, step: PLAIN_LORE.boardWindowAgentsStep }
  const session = beat.session ?? running.session
  const withAgents: BusService = { ...held, ...(session === null ? {} : { session }), subagents }
  return tiles.includes(held) ? tiles.map(tile => tile === held ? withAgents : tile) : [withAgents]
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

function gaugesOfBeat(payload: Record<string, unknown>): ServiceGauges {
  return { context: positiveOrNull(payload.context), spent: positiveOrNull(payload.spent), model: text(payload.model) }
}

function sessionServices(events: BoardEvents, cards: BusCard[], now: Date): BusService[] {
  const byId = new Map(cards.map(card => [card.id, card] as const))
  const latest = new Map<string, SessionBeat>()
  const measured = new Map<string, Record<string, unknown>>()
  for (const row of events.of(SESSION_HEARTBEAT)) {
    const payload = payloadOf(row.payload)
    const session = text(payload.session) ?? `#${row.card_id ?? '?'}`
    latest.set(session, { row, step: text(payload.step) ?? 'session' })
    if (row.legacy === 0)
      measured.set(session, payload)
  }
  const shown = new Map<string, SessionBeat & { session: string }>()
  for (const [session, beat] of latest) {
    const card = beat.row.card_id === null ? undefined : byId.get(beat.row.card_id)
    if (!isFresh(beat.row.ts, now) || (card !== undefined && isFinished(card)) || !stepMatchesStage(beat.step, card))
      continue
    const key = `${beat.step.split(' ')[0]!} #${beat.row.card_id ?? '?'}`
    if ((shown.get(key)?.row.id ?? -1) < beat.row.id)
      shown.set(key, { ...beat, session })
  }
  return [...shown.values()].map(({ row, step, session }) => {
    const payload = measured.get(session)
    const subagents = subagentReadings(payload?.subagents)
    return { role: step.split(' ')[0]!, task: `#${row.card_id ?? '?'}`, tree: null, step: `${step} · pulse ${minutesAgo(row.ts!, now)} min ago`, session, ...(payload === undefined ? {} : { gauges: gaugesOfBeat(payload) }), ...(subagents.length === 0 ? {} : { subagents }) }
  })
}

function processKey(service: BusService): string {
  return `${service.role} ${service.task}`
}

function oneTilePerProcess(tasks: BusService[], sessions: BusService[]): BusService[] {
  const shown = new Set(sessions.map(processKey))
  return tasks.filter(task => !shown.has(processKey(task)))
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

function queuesIn(db: BusDb, states: readonly string[]): Map<number, string> {
  const rows = db.prepare(`SELECT card_id, queue FROM tasks WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY id`).all(...states) as unknown as { card_id: number, queue: string }[]
  return new Map(rows.filter(row => STAGE_OF_QUEUE[row.queue] !== undefined).map(row => [row.card_id, row.queue] as const))
}

function stageOf(state: string | null, closed: boolean, queue: string | undefined, leased: string | undefined): CardStage {
  if (state === 'stopped' && leased !== undefined)
    return STAGE_OF_QUEUE[leased]!
  if (state !== null && SETTLED_STATES.has(state))
    return STAGE_OF_STATE[state]!
  if (closed)
    return 'merged'
  return (queue === undefined ? undefined : STAGE_OF_QUEUE[queue]) ?? STAGE_OF_STATE[state ?? ''] ?? 'planned'
}

function laneOf(db: BusDb, row: CardRow): string | null {
  return row.state !== null && LANELESS_STATES.has(row.state) ? null : currentLane(db, row.id)
}

function share(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

export function sliceParentOf(value: unknown): SliceParent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null
  const fields = value as Record<string, unknown>
  const [card, part, of] = [share(fields.card), share(fields.part), share(fields.of)]
  return card === null || part === null || of === null || part > of ? null : { card, part, of }
}

function sliceParentIn(row: CardRow): SliceParent | null {
  return sliceParentOf(payloadOf(row.admitted_parent ?? '')) ?? sliceParentOf(payloadOf(row.backfilled_parent ?? ''))
}

function cardsOf(db: BusDb, events: BoardEvents): BusCard[] {
  const rows = db.prepare(`
    SELECT c.card_id AS id, c.state, c.pr, b.card_line AS line, e.ts AS since, b.card_id IS NOT NULL AS body,
      (SELECT json_extract(a.payload, '$.parent') FROM events a WHERE a.legacy = 0 AND a.type = '${CARD_ADMITTED}' AND a.card_id = c.card_id AND json_valid(a.payload) AND json_type(a.payload, '$.parent') = 'object' ORDER BY a.id DESC LIMIT 1) AS admitted_parent,
      (SELECT json_extract(f.payload, '$.cards."' || c.card_id || '"') FROM events f WHERE f.legacy = 0 AND f.type = '${SLICE_PARENTS_BACKFILLED}' AND json_valid(f.payload) ORDER BY f.id LIMIT 1) AS backfilled_parent
    FROM cards c LEFT JOIN card_bodies b ON b.card_id = c.card_id LEFT JOIN events e ON e.id = c.event_id
    ORDER BY c.card_id
  `).all() as unknown as CardRow[]
  const closed = new Map(events.of(CARD_VERIFIED).filter(row => row.legacy === 0).map(row => [row.card_id, row.ts] as const))
  const queues = queuesIn(db, OPEN_TASK_STATES)
  const leased = queuesIn(db, [LEASED])
  return rows.map((row) => {
    const lane = laneOf(db, row)
    const parent = sliceParentIn(row) ?? undefined
    return { id: row.id, state: row.state, stage: TERMINAL_LANES.has(lane ?? '') ? 'dropped' : stageOf(row.state, closed.has(row.id), queues.get(row.id), leased.get(row.id)), lane, line: row.line, since: row.since, body: Boolean(row.body), closed: closed.has(row.id), closedAt: closed.get(row.id) ?? null, ...(parent === undefined ? {} : { parent }) }
  })
}

function lastPulse(db: BusDb): string | null {
  const row = db.prepare('SELECT ts FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(BUS_PULSE) as { ts: string | null } | undefined
  return row?.ts ?? null
}

const LAST_NODE_CAPACITY = `
  SELECT queue, slots FROM (
    SELECT json_extract(payload, '$.queue') AS queue, json_extract(payload, '$.slots') AS slots, row_number() OVER (PARTITION BY json_extract(payload, '$.queue') ORDER BY ts DESC) AS rank
    FROM heartbeats WHERE type = ? AND json_valid(payload) AND json_type(payload, '$.queue') = 'text'
  ) WHERE rank = 1
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
  const cardReading = readLastReduced(db, [CARDS], () => cardsOf(db, events))
  const cards = cardReading.rows
  const sessions = sessionServices(events, cards, now)
  const waits = lastReducedOwnerWaits(db)
  return {
    at: now.toISOString(),
    goal: goalOf(db, now),
    waits: waits.rows,
    ...waits.behind === null ? {} : { waitsStale: behindLine(waits.behind) },
    pulse: lastPulse(db),
    slots: slotsOf(db),
    cards,
    ...cardReading.behind === null ? {} : { cardsStale: behindLine(cardReading.behind) },
    services: [...windowTiles(db, events, now), ...oneTilePerProcess(taskServices(db), sessions), ...sessions],
    matrices: checkMatrices(db),
    failure: lastFailure(events),
    reviewQueue: Number(queue.n),
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

import type { EventRow as QueriedEvent, TaskRow } from '../../../scripts/core/card-readings.js'
import type { BusPanelFacts } from './bus-panel.js'
import type { GateRunRow } from './gate-runs.js'
import type { Goal } from './goal.js'
import type { BusDb, OwnerWait } from './index.js'
import type { QueuedStanding, TranscriptReader } from './sessions.js'
import { busPanelRow, cardsWithTheirLines, EITHER_JOURNAL, events as eventsOf, tasksInStates as inStates, lastObjectFieldPerCard, lastSlotsPerQueue, latest, newestEventsOfEachCard } from '../../../scripts/core/card-readings.js'
import { BOARD_ALARM, BOARD_ALARM_CLEARED, BUS_PULSE, CARD_ADMITTED, CARD_CONTINUED, CARD_FELL, CARD_PULSE, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, CHECKS_MATRIX_EVENT, GATE_RUN, LANE_HELD, NETWATCH_SKIPPED, PR_GROUPS, PROCESS_HEARTBEAT, REVIEW_DRIP, SESSION_HEARTBEAT, SLICE_PARENTS_BACKFILLED, TASK_RENEWED, TERMINAL_LANES, WINDOW_HEARTBEAT, WINDOW_SUBAGENT_EVENT } from '../../../scripts/core/events.js'
import { PLAIN_LORE } from '../../ui/lore.js'
import { busPanelFacts, panelSince, payloadOf, RECENT_EVENTS, text } from './bus-panel.js'
import { gateRunFacts } from './gate-runs.js'
import { goalOf } from './goal.js'
import { clientTranscriptReader, sessionRowTime } from './sessions.js'

export interface LastReducedRows<T> {
  rows: T
  behind: string | null
}

export interface BoardBus {
  exists: (file: string) => boolean
  readOnly: <T>(file: string, read: (db: BusDb) => T) => T
  inOrderMark: string
  lastReducedCards: <T>(db: BusDb, read: () => T) => LastReducedRows<T>
  lastReducedOwnerWaits: (db: BusDb) => LastReducedRows<OwnerWait[]>
  currentLane: (db: BusDb, card: number) => string | null
}

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
const REVIEW_QUEUE = 'review'

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

export type { BusPanelFacts } from './bus-panel.js'
export type { OwnerWait, OwnerWaitNeed } from './index.js'

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

export interface CrawlerReading {
  id: string
  kind: string
  description: string | null
  startedAt: string | null
  state: string
  context: number | null
  spent: number | null
}

export interface BusWindow {
  core: number | null
  skills: string[]
  crawlers: CrawlerReading[]
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
  groups?: BusGroup[]
  shadow?: BusShadow
  tails?: BusTail[]
  queued?: QueuedStanding[]
  laneHeads?: LaneHead[]
  window?: BusWindow
  panel?: BusPanelFacts
}

export interface LaneHead {
  lane: string
  card: number
  reason: string
}

export interface BusTail {
  card: number
  pr: number | null
  head: string | null
  finding: string
}

export interface BusGroup {
  prs: readonly number[]
  modules: readonly string[]
  turn: number | null
}

export interface BusShadow {
  needsUpdate: number
  needsVerification: number
}

export type BusReading
  = | { status: 'read', file: string, facts: BusFacts, gateRuns?: GateRunRow[] }
    | { status: 'absent', file: string }
    | { status: 'unreadable', file: string, reason: string }

export type BusReader = (bus: BoardBus) => BusReading

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

interface RoleRow {
  role: string
  status: string
  state: string
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function verdictOf(db: BusDb, pr: number | null): string | null {
  return pr === null ? null : (db.prepare('SELECT verdict_on_head FROM prs WHERE pr = ?').get(pr) as { verdict_on_head: string | null } | undefined)?.verdict_on_head ?? null
}

function stepOf(db: BusDb, row: TaskRow): string {
  if (row.queue === 'review')
    return `review ${verdictOf(db, row.pr) ?? 'pending'}`
  return row.head === null ? row.queue : `${row.queue} ${row.head.slice(0, SHORT_SHA)}`
}

function taskServices(db: BusDb): BusService[] {
  return inStates(db, [LEASED]).map(row => ({ role: row.queue, task: `#${row.card_id}`, tree: null, step: stepOf(db, row) }))
}

function isSilent(row: EventRow, now: Date): boolean {
  const at = row.ts === null ? Number.NaN : Date.parse(row.ts)
  return Number.isNaN(at) || now.getTime() - at > SUBAGENT_SHOWN_HOURS * HOUR_MS
}

function windowRoles(db: BusDb): BusService[] {
  const rows = db.prepare('SELECT role, status, state FROM roles ORDER BY role').all() as unknown as RoleRow[]
  return rows.map(row => ({ role: 'window', task: row.role, tree: null, step: `${row.state} · ${row.status}` }))
}

const SESSION_STARTS = [CARD_STARTED, CARD_CONTINUED]
const SESSION_ENDS = [CARD_STOPPED, CARD_SESSION_ENDED]
const BOARD_EVENT_TYPES = [WINDOW_SUBAGENT_EVENT, SESSION_HEARTBEAT, CARD_PULSE, ...SESSION_STARTS, CARD_SESSION_ENDED, CARD_FELL, CARD_STOPPED, CARD_VERIFIED, PR_GROUPS, REVIEW_DRIP, GATE_RUN, LANE_HELD]

interface BoardEvents {
  of: (type: string) => EventRow[]
}

function boardRowOf(row: QueriedEvent): EventRow {
  return { id: row.id, ts: row.ts, type: row.type, card_id: row.card_id, pr: row.pr, dedupe_key: row.dedupe_key, legacy: row.legacy ? 1 : 0, payload: row.payload }
}

function boardEvents(db: BusDb): BoardEvents {
  const rows = eventsOf(db, { types: BOARD_EVENT_TYPES, legacy: EITHER_JOURNAL }).map(boardRowOf)
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

function crawlerReadings(value: unknown): CrawlerReading[] {
  return (Array.isArray(value) ? value as unknown[] : []).flatMap((entry) => {
    if (entry === null || typeof entry !== 'object')
      return []
    const crawler = entry as Record<string, unknown>
    const [id, kind, state] = [text(crawler.id), text(crawler.kind), text(crawler.state)]
    return id === null || state === null ? [] : [{ id, kind: kind ?? id, description: text(crawler.description), startedAt: text(crawler.started_at), state, context: positiveOrNull(crawler.ctx), spent: positiveOrNull(crawler.spent) }]
  })
}

function windowOfBeat(payload: Record<string, unknown>): BusWindow {
  const skills = Array.isArray(payload.skills) ? payload.skills.flatMap(skill => text(skill) ?? []) : []
  return { core: share(payload.core), skills, crawlers: crawlerReadings(payload.crawlers) }
}

const NO_WINDOW_BEAT: BusWindow = { core: null, skills: [], crawlers: [] }

function lastWindowBeat(db: BusDb, now: Date): { session: string | null, subagents: SubagentReading[], window: BusWindow } {
  const found = latest(db, { types: [WINDOW_HEARTBEAT] })
  const row = found === null ? undefined : boardRowOf(found)
  if (row === undefined || isSilent(row, now))
    return { session: null, subagents: [], window: NO_WINDOW_BEAT }
  const payload = payloadOf(row.payload)
  return { session: text(payload.session), subagents: subagentReadings(payload.subagents), window: windowOfBeat(payload) }
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

function checkMatrices(db: BusDb): BusMatrix[] {
  const rows = eventsOf(db, { types: [CHECKS_MATRIX_EVENT], withPr: true, legacy: EITHER_JOURNAL })
  const newest = new Map<number, BusMatrix>()
  for (const row of rows) {
    const payload = payloadOf(row.payload)
    const pr = row.pr!
    newest.set(pr, { pr, head: row.head, full: text(payload.full), killed: count(payload.killed), survived: count(payload.survived), notRun: count(payload.notRun) })
  }
  return [...newest.values()].sort((a, b) => a.pr - b.pr)
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

function cardTrees(events: BoardEvents): Map<number, string> {
  const trees = new Map<number, string>()
  for (const row of events.of(CARD_STARTED)) {
    const worktree = text(payloadOf(row.payload).worktree)
    if (row.legacy === 0 && row.card_id !== null && worktree !== null)
      trees.set(row.card_id, worktree)
  }
  return trees
}

const LAUNCH_STEP = 'launch'

function sessionOf(row: EventRow): string {
  return text(payloadOf(row.payload).session) ?? `#${row.card_id ?? '?'}`
}

function liveStarts(events: BoardEvents): Map<string, SessionBeat> {
  const open = new Map<number, EventRow>()
  const rows = [...SESSION_STARTS, ...SESSION_ENDS].flatMap(type => events.of(type)).filter(row => row.legacy === 0 && row.card_id !== null).sort((a, b) => a.id - b.id)
  for (const row of rows) {
    if (SESSION_STARTS.includes(row.type))
      open.set(row.card_id!, row)
    else
      open.delete(row.card_id!)
  }
  return new Map([...open.values()].filter(row => row.ts !== null).map(row => [sessionOf(row), { row, step: text(payloadOf(row.payload).step) ?? LAUNCH_STEP }] as const))
}

function beatsOf(events: BoardEvents): EventRow[] {
  const pulses = events.of(CARD_PULSE).filter(row => row.legacy === 0 && row.card_id !== null)
  return [...events.of(SESSION_HEARTBEAT), ...pulses].sort((a, b) => a.id - b.id)
}

function pulseOf(ts: string, session: string, now: Date): Pick<BusService, 'session'> & { line: string } {
  const minutes = minutesAgo(ts, now)
  return isFresh(ts, now) ? { line: `pulse ${minutes} min ago`, session } : { line: PLAIN_LORE.boardSessionNoPulse(minutes) }
}

function sessionServices(events: BoardEvents, cards: BusCard[], now: Date, transcripts: TranscriptReader): BusService[] {
  const byId = new Map(cards.map(card => [card.id, card] as const))
  const trees = cardTrees(events)
  const live = liveStarts(events)
  const latest = new Map<string, SessionBeat>(live)
  const measured = new Map<string, Record<string, unknown>>()
  const firstSeen = new Map<string, string>()
  for (const row of beatsOf(events)) {
    const payload = payloadOf(row.payload)
    const session = sessionOf(row)
    if (row.ts !== null && !firstSeen.has(session))
      firstSeen.set(session, row.ts)
    const pulse = row.type === CARD_PULSE
    latest.set(session, { row, step: (pulse ? latest.get(session)?.step : text(payload.step)) ?? (pulse ? LAUNCH_STEP : 'session') })
    if (row.legacy === 0 && !pulse)
      measured.set(session, payload)
  }
  const shown = new Map<string, SessionBeat & { session: string }>()
  for (const [session, beat] of latest) {
    const card = beat.row.card_id === null ? undefined : byId.get(beat.row.card_id)
    if (beat.row.ts === null || (!live.has(session) && !isFresh(beat.row.ts, now)) || (card !== undefined && isFinished(card)) || !stepMatchesStage(beat.step, card))
      continue
    const key = `${beat.step.split(' ')[0]!} #${beat.row.card_id ?? '?'}`
    if ((shown.get(key)?.row.id ?? -1) < beat.row.id)
      shown.set(key, { ...beat, session })
  }
  return [...shown.values()].map(({ row, step, session }) => {
    const payload = measured.get(session)
    const subagents = subagentReadings(payload?.subagents)
    const time = sessionRowTime(transcripts, session, firstSeen.get(session) ?? row.ts!, row.card_id === null ? null : trees.get(row.card_id) ?? null, now)
    const { line, ...beating } = pulseOf(row.ts!, session, now)
    return { role: step.split(' ')[0]!, task: `#${row.card_id ?? '?'}`, tree: null, step: `${step} · ${line} · ${time}`, ...beating, ...(payload === undefined ? {} : { gauges: gaugesOfBeat(payload) }), ...(subagents.length === 0 ? {} : { subagents }) }
  })
}

function queuedStandings(db: BusDb): QueuedStanding[] {
  const rows = openTasks(db)
  return rows.flatMap((row, index) => {
    if (row.state === LEASED)
      return []
    const behind = rows.slice(0, index).filter(ahead => ahead.queue === row.queue).map(ahead => ahead.card)
    return [{ card: row.card, queue: row.queue, since: row.since, behind }]
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
  return new Map(inStates(db, states).filter(row => STAGE_OF_QUEUE[row.queue] !== undefined).map(row => [row.card_id, row.queue] as const))
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

function laneOf(bus: BoardBus, db: BusDb, row: { id: number, state: string | null }): string | null {
  return row.state !== null && LANELESS_STATES.has(row.state) ? null : bus.currentLane(db, row.id)
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

interface SliceParents {
  admitted: ReadonlyMap<number, string>
  backfilled: Record<string, unknown>
}

function sliceParents(db: BusDb): SliceParents {
  const backfill = eventsOf(db, { types: [SLICE_PARENTS_BACKFILLED], valid: true, limit: 1 })[0]
  const cards = backfill === undefined ? undefined : payloadOf(backfill.payload).cards
  return {
    admitted: lastObjectFieldPerCard(db, CARD_ADMITTED, 'parent'),
    backfilled: cards !== null && typeof cards === 'object' && !Array.isArray(cards) ? cards as Record<string, unknown> : {},
  }
}

function sliceParentIn(parents: SliceParents, card: number): SliceParent | null {
  return sliceParentOf(payloadOf(parents.admitted.get(card) ?? '')) ?? sliceParentOf(parents.backfilled[String(card)])
}

function stampsOf(db: BusDb, ids: readonly number[]): Map<number, string> {
  return new Map(eventsOf(db, { ids: [...new Set(ids)], legacy: EITHER_JOURNAL }).map(row => [row.id, row.ts] as const))
}

function cardsOf(bus: BoardBus, db: BusDb, events: BoardEvents): BusCard[] {
  const rows = cardsWithTheirLines(db)
  const since = stampsOf(db, rows.map(row => row.event_id))
  const parents = sliceParents(db)
  const closed = new Map(events.of(CARD_VERIFIED).filter(row => row.legacy === 0).map(row => [row.card_id, row.ts] as const))
  const queues = queuesIn(db, OPEN_TASK_STATES)
  const leased = queuesIn(db, [LEASED])
  return rows.map((row) => {
    const lane = laneOf(bus, db, row)
    const parent = sliceParentIn(parents, row.id) ?? undefined
    return { id: row.id, state: row.state, stage: TERMINAL_LANES.has(lane ?? '') ? 'dropped' : stageOf(row.state, closed.has(row.id), queues.get(row.id), leased.get(row.id)), lane, line: row.line, since: since.get(row.event_id) ?? null, body: row.body, closed: closed.has(row.id), closedAt: closed.get(row.id) ?? null, ...(parent === undefined ? {} : { parent }) }
  })
}

function nodeCapacity(db: BusDb): Map<string, number> {
  return new Map(lastSlotsPerQueue(db, PROCESS_HEARTBEAT).flatMap(row => typeof row.slots === 'number' && Number.isSafeInteger(row.slots) && row.slots > 0 ? [[row.queue, row.slots] as const] : []))
}

function tilesByRole(tiles: readonly BusService[]): Map<string, number> {
  const counted = new Map<string, number>()
  for (const tile of tiles)
    counted.set(tile.role, (counted.get(tile.role) ?? 0) + 1)
  return counted
}

function slotsOf(db: BusDb, sessions: readonly BusService[]): BusSlot[] {
  const leased = new Map<string, number>()
  for (const task of inStates(db, [LEASED]))
    leased.set(task.queue, (leased.get(task.queue) ?? 0) + 1)
  const capacity = nodeCapacity(db)
  const tiles = tilesByRole(sessions)
  const used = (queue: string): number => Math.max(leased.get(queue) ?? 0, tiles.get(queue) ?? 0)
  return [...new Set([...leased.keys(), ...capacity.keys()])].sort().map(queue => ({ queue, used: used(queue), total: capacity.get(queue) ?? null }))
}

export interface BusTask {
  id: number
  queue: string
  card: number
  pr: number | null
  head: string | null
  state: string
  since: string | null
}

export interface BusCardEvent {
  id: number
  ts: string | null
  type: string
  pr: number | null
}

export function openTasks(db: BusDb): BusTask[] {
  const tasks = inStates(db, OPEN_TASK_STATES)
  const since = stampsOf(db, tasks.map(task => task.event_id))
  return tasks.map(task => ({ id: task.id, queue: task.queue, card: task.card_id, pr: task.pr, head: task.head, state: task.state, since: since.get(task.event_id) ?? null }))
}

export function latestCardEvents(db: BusDb, perCard: number): Map<number, BusCardEvent[]> {
  const events = new Map<number, BusCardEvent[]>()
  for (const { card, ...event } of newestEventsOfEachCard(db, perCard))
    events.set(card, [...events.get(card) ?? [], event])
  return events
}

function numbers(value: unknown): number[] | null {
  return Array.isArray(value) && value.every(entry => Number.isSafeInteger(entry)) ? value as number[] : null
}

function groupOf(value: unknown): BusGroup[] {
  if (value == null || typeof value !== 'object')
    return []
  const { prs, modules, turn } = value as Record<string, unknown>
  const members = numbers(prs)
  const names = Array.isArray(modules) && modules.every(name => typeof name === 'string') ? modules as string[] : null
  return members === null || names === null ? [] : [{ prs: members, modules: names, turn: Number.isSafeInteger(turn) ? turn as number : null }]
}

function orderFacts(events: BoardEvents): Pick<BusFacts, 'groups' | 'shadow'> {
  const last = events.of(PR_GROUPS).at(-1)
  if (last === undefined)
    return {}
  const payload = payloadOf(last.payload)
  return {
    groups: Array.isArray(payload.groups) ? payload.groups.flatMap(groupOf) : [],
    shadow: { needsUpdate: count(payload.needsUpdate), needsVerification: count(payload.needsVerification) },
  }
}

function cardTails(events: BoardEvents): BusTail[] {
  const standing = new Map<string, BusTail>()
  for (const row of events.of(REVIEW_DRIP)) {
    const payload = payloadOf(row.payload)
    const finding = text(payload.finding)
    if (row.legacy !== 0 || row.card_id === null || finding === null)
      continue
    const key = `${row.card_id}\n${finding}`
    standing.delete(key)
    standing.set(key, { card: row.card_id, pr: row.pr, head: text(payload.head), finding })
  }
  return [...standing.values()].sort((a, b) => a.card - b.card)
}

function tailFacts(events: BoardEvents): Pick<BusFacts, 'tails'> {
  const tails = cardTails(events)
  return tails.length === 0 ? {} : { tails }
}

function laneHeads(events: BoardEvents, cards: readonly BusCard[]): LaneHead[] {
  const planned = new Set(cards.filter(card => card.stage === 'planned').map(card => card.id))
  const latest = new Map<string, LaneHead | null>()
  for (const row of events.of(LANE_HELD).filter(each => each.legacy === 0)) {
    const payload = payloadOf(row.payload)
    const [lane, reason] = [text(payload.lane), text(payload.reason)]
    if (lane !== null)
      latest.set(lane, row.card_id === null || reason === null ? null : { lane, card: row.card_id, reason })
  }
  return [...latest.values()].filter((head): head is LaneHead => head !== null && planned.has(head.card)).sort((a, b) => a.lane.localeCompare(b.lane, undefined, { numeric: true }))
}

function laneHeadFacts(events: BoardEvents, cards: readonly BusCard[]): Pick<BusFacts, 'laneHeads'> {
  const heads = laneHeads(events, cards)
  return heads.length === 0 ? {} : { laneHeads: heads }
}

function queuedFacts(db: BusDb): Pick<BusFacts, 'queued'> {
  const queued = queuedStandings(db)
  return queued.length === 0 ? {} : { queued }
}

export const QUIET_EVENT_TYPES: readonly string[] = [SESSION_HEARTBEAT, BUS_PULSE, WINDOW_HEARTBEAT, PROCESS_HEARTBEAT, CARD_PULSE, NETWATCH_SKIPPED, TASK_RENEWED]

function panelOf(bus: BoardBus, db: BusDb, now: Date): BusPanelFacts {
  const row = busPanelRow(db, {
    since: panelSince(now),
    mark: bus.inOrderMark,
    pulse: BUS_PULSE,
    quiet: QUIET_EVENT_TYPES,
    recent: RECENT_EVENTS,
    heartbeat: PROCESS_HEARTBEAT,
    alarm: BOARD_ALARM,
    cleared: BOARD_ALARM_CLEARED,
  })
  return busPanelFacts(row, now)
}

export function boardFacts(bus: BoardBus, db: BusDb, now: Date, transcripts: TranscriptReader = clientTranscriptReader): BusFacts {
  const reviewQueue = inStates(db, OPEN_TASK_STATES).filter(task => task.queue === REVIEW_QUEUE).length
  const events = boardEvents(db)
  const cardReading = bus.lastReducedCards(db, () => cardsOf(bus, db, events))
  const cards = cardReading.rows
  const sessions = sessionServices(events, cards, now, transcripts)
  const waits = bus.lastReducedOwnerWaits(db)
  const panel = panelOf(bus, db, now)
  return {
    at: now.toISOString(),
    goal: goalOf(db, now),
    waits: waits.rows,
    ...waits.behind === null ? {} : { waitsStale: waits.behind },
    pulse: panel.pulses[0] ?? null,
    slots: slotsOf(db, sessions),
    window: lastWindowBeat(db, now).window,
    cards,
    ...cardReading.behind === null ? {} : { cardsStale: cardReading.behind },
    services: [...windowTiles(db, events, now), ...oneTilePerProcess(taskServices(db), sessions), ...sessions],
    matrices: checkMatrices(db),
    failure: lastFailure(events),
    reviewQueue,
    ...orderFacts(events),
    ...tailFacts(events),
    ...queuedFacts(db),
    ...laneHeadFacts(events, cards),
    panel,
  }
}

export function busReaderAt(file: string, clock: () => Date = () => new Date(), transcripts: TranscriptReader = clientTranscriptReader): BusReader {
  return (bus) => {
    if (!bus.exists(file))
      return { status: 'absent', file }
    try {
      return bus.readOnly(file, (db) => {
        const now = clock()
        return { status: 'read', file, facts: boardFacts(bus, db, now, transcripts), ...gateRunFacts(boardEvents(db).of(GATE_RUN), now) }
      })
    }
    catch (error) {
      return { status: 'unreadable', file, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

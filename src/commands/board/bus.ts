import type { BusDb } from '../cost/bus.js'
import type { Goal } from './goal.js'
import { existsSync } from 'node:fs'
import { BUS_PULSE, CARD_FELL, CARD_STOPPED, CARD_VERIFIED, CHECKS_MATRIX_EVENT, POLICY_DENIED, QUESTION_OWNER, SESSION_HEARTBEAT, WINDOW_SUBAGENT_EVENT } from '../../../scripts/core/events.js'
import { withReadOnlyBus } from '../cost/bus.js'
import { goalOf } from './goal.js'

export const SESSION_DEATH_KEY = `${CARD_STOPPED}:session-end:`
export const SHORT_SHA = 7
export const SUBAGENT_SHOWN_HOURS = 12
export const SESSION_SHOWN_MINUTES = 20
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
const SETTLED_STATES = new Set(['merged', 'stopped', 'dropped', 'closed'])
const OPEN_TASK_STATES = ['queued', 'leased']
const OPEN_PR = 'open'
const PATH_LINE = /^Path \(D-76\):.*$/gm

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

export interface PlanStage {
  stage: CardStage
  cards: number[]
}

export type OwnerWaitKind = 'question' | 'decision' | 'version'

export interface OwnerWait {
  kind: OwnerWaitKind
  card: number | null
  pr: number | null
  detail: string | null
  since: string | null
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
}

export interface BusFacts {
  at: string
  goal: Goal | null
  plan: PlanStage[] | null
  waits: OwnerWait[]
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

function sessionServices(events: BoardEvents, cards: BusCard[], now: Date): BusService[] {
  const finished = new Set(cards.filter(isFinished).map(card => card.id))
  const latest = new Map<string, BusService>()
  for (const row of events.of(SESSION_HEARTBEAT)) {
    if (row.ts === null || now.getTime() - Date.parse(row.ts) > SESSION_SHOWN_MINUTES * MINUTE_MS || (row.card_id !== null && finished.has(row.card_id)))
      continue
    const payload = payloadOf(row.payload)
    const task = `#${row.card_id ?? '?'}`
    const step = text(payload.step) ?? 'session'
    latest.set(text(payload.session) ?? task, { role: step.split(' ')[0]!, task, tree: null, step: `${step} · pulse ${minutesAgo(row.ts, now)} min ago` })
  }
  return [...latest.values()]
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

function cardsOf(db: BusDb, events: BoardEvents): BusCard[] {
  const rows = db.prepare(`
    SELECT c.card_id AS id, c.state, c.pr, b.lane, b.card_line AS line, e.ts AS since, b.card_id IS NOT NULL AS body
    FROM cards c LEFT JOIN card_bodies b ON b.card_id = c.card_id LEFT JOIN events e ON e.id = c.event_id
    ORDER BY c.card_id
  `).all() as unknown as CardRow[]
  const closed = new Map(events.of(CARD_VERIFIED).filter(row => row.legacy === 0).map(row => [row.card_id, row.ts] as const))
  const queues = openQueues(db)
  return rows.map(row => ({ id: row.id, state: row.state, stage: stageOf(row.state, closed.has(row.id), queues.get(row.id)), lane: row.lane, line: row.line, since: row.since, body: Boolean(row.body), closed: closed.has(row.id), closedAt: closed.get(row.id) ?? null }))
}

function namesRelease(text: string, release: string): boolean {
  const named = new RegExp(`(?<![\\d.])${release.replace('.', '\\.')}(?!\\.?\\d)`)
  return (text.match(PATH_LINE) ?? []).some(line => named.test(line))
}

function planOf(db: BusDb, goal: Goal | null, cards: BusCard[]): PlanStage[] | null {
  if (goal === null)
    return null
  const bodies = db.prepare('SELECT card_id AS id, text FROM card_bodies ORDER BY card_id').all() as unknown as { id: number, text: string }[]
  const stages = new Map(cards.map(card => [card.id, card.stage] as const))
  const plan = bodies.filter(body => namesRelease(body.text, goal.release)).map(body => ({ id: body.id, stage: stages.get(body.id) ?? 'planned' }))
  return CARD_STAGES.map(stage => ({ stage, cards: plan.filter(card => card.stage === stage).map(card => card.id) }))
}

interface WaitRow {
  card_id: number | null
  pr: number | null
  ts: string | null
  payload: string
}

const OPEN_OWNER_QUESTIONS = `
  SELECT stop.card_id, stop.pr, stop.ts, stop.payload FROM events AS stop JOIN cards ON cards.card_id = stop.card_id
  WHERE stop.type = ? AND stop.legacy = 0 AND cards.state = 'stopped' AND json_extract(stop.payload, '$.reason') = ?
    AND stop.id = (SELECT max(last.id) FROM events AS last WHERE last.type = stop.type AND last.card_id = stop.card_id)
    AND NOT EXISTS (SELECT 1 FROM decisions AS answer, json_each(answer.scope) AS named WHERE answer.scope IS NOT NULL AND answer.event_id > stop.id AND named.value = stop.card_id)
  ORDER BY stop.id
`

const OPEN_AUTHORITY_DENIALS = `
  SELECT denial.card_id, denial.pr, denial.ts, denial.payload FROM events AS denial JOIN prs ON prs.pr = denial.pr
  WHERE denial.type = ? AND denial.legacy = 0 AND prs.state = ? AND json_extract(denial.payload, '$.kind') = 'authority'
    AND denial.id = (SELECT max(last.id) FROM events AS last WHERE last.type = denial.type AND last.legacy = 0 AND last.pr = denial.pr)
  ORDER BY denial.id
`

function waitOf(kind: OwnerWaitKind, row: WaitRow): OwnerWait {
  return { kind, card: row.card_id, pr: row.pr, detail: text(payloadOf(row.payload).detail), since: row.ts }
}

function ownerWaits(db: BusDb): OwnerWait[] {
  const questions = db.prepare(OPEN_OWNER_QUESTIONS).all(CARD_STOPPED, QUESTION_OWNER) as unknown as WaitRow[]
  const decisions = db.prepare(OPEN_AUTHORITY_DENIALS).all(POLICY_DENIED, OPEN_PR) as unknown as WaitRow[]
  const versions = db.prepare('SELECT pr FROM prs WHERE card_id IS NULL AND state = ? ORDER BY pr').all(OPEN_PR) as unknown as { pr: number }[]
  return [
    ...questions.map(row => waitOf('question', row)),
    ...decisions.map(row => waitOf('decision', row)),
    ...versions.map(row => ({ kind: 'version' as const, card: null, pr: row.pr, detail: null, since: null })),
  ]
}

function lastPulse(db: BusDb): string | null {
  const row = db.prepare('SELECT ts FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(BUS_PULSE) as { ts: string | null } | undefined
  return row?.ts ?? null
}

function slotsInUse(db: BusDb): BusSlot[] {
  return db.prepare(`SELECT queue, count(*) AS used FROM tasks WHERE state = 'leased' GROUP BY queue ORDER BY queue`).all() as unknown as BusSlot[]
}

export function busFacts(db: BusDb, now: Date): BusFacts {
  const queue = db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'review' AND state IN ('queued', 'leased')`).get() as { n: number }
  const events = boardEvents(db)
  const goal = goalOf(db)
  const cards = cardsOf(db, events)
  return {
    at: now.toISOString(),
    goal,
    plan: planOf(db, goal, cards),
    waits: ownerWaits(db),
    pulse: lastPulse(db),
    slots: slotsInUse(db),
    cards,
    services: [...windowRoles(db), ...taskServices(db), ...windowServices(events, now), ...sessionServices(events, cards, now)],
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

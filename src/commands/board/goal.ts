import type { Lore } from '../../ui/lore.js'
import type { BusDb } from '../cost/bus.js'
import { CARD_ADMITTED, CARD_MOVED, OPEN_PLAN, TERMINAL_LANES } from '../../../scripts/core/events.js'

export const RELEASE_STAGES = ['queued', 'in_progress', 'review', 'delivered'] as const
const RECENT_HOURS = 24
const HOUR_MS = 3_600_000
export const MARK_WORDS: Readonly<Record<CardMark, string>> = { delivered: 'merged', in_progress: 'in work', review: 'review', queued: 'queue', dropped: 'dropped' }
const LINE_STAGES: readonly ReleaseStage[] = ['in_progress', 'review', 'queued']
const MERGED = 'merged'
const DROPPED_STATES = new Set(['dropped', 'closed'])
const REVIEW_STATES = new Set(['in_review', 'ready'])
const REVIEW_QUEUES = new Set(['review', 'merge'])
const WORK_STATES = new Set(['running', 'changes', 'stopped'])
const WORK_QUEUES = new Set(['answer'])
export const GATE_DUE = 'due'
export const GATE_OPEN = 'open'

export type ReleaseStage = typeof RELEASE_STAGES[number]
export const DROPPED = 'dropped'
export type CardMark = typeof DROPPED | ReleaseStage

export interface ReleaseCard {
  card: number
  mark: CardMark
}

export interface ReleaseGate {
  word: string
  status: typeof GATE_DUE | typeof GATE_OPEN
}

export interface PlanProgress {
  id: string
  title: string
  goal: string
  delivered: number
  total: number
  remainder: number
  stages: Record<ReleaseStage, number>
  cards: ReleaseCard[]
  gate: ReleaseGate | null
  deliveredRecently: number
}

export interface Goal {
  plans: PlanProgress[]
  backlog: number
}

interface CardRow {
  id: number
  state: string | null
  pr_state: string | null
  queue: string | null
  lane: string | null
  at: string | null
}

interface CardReading {
  mark: CardMark
  at: string | null
}

interface ReleaseRow {
  id: string
  title: string
  goal: string
  gate: string | null
}

const CARD_READINGS = `
  SELECT cards.card_id AS id, cards.state, prs.state AS pr_state, coalesce(merge.ts, own.ts) AS at,
    (SELECT tasks.queue FROM tasks WHERE tasks.card_id = cards.card_id AND tasks.state IN ('queued', 'leased') ORDER BY tasks.id DESC LIMIT 1) AS queue,
    coalesce((SELECT json_extract(lane.payload, '$.lane') FROM events AS lane WHERE lane.legacy = 0 AND lane.type IN ('${CARD_ADMITTED}', '${CARD_MOVED}') AND lane.card_id = cards.card_id AND json_type(lane.payload, '$.lane') = 'text' ORDER BY lane.id DESC LIMIT 1), bodies.lane) AS lane
  FROM cards LEFT JOIN prs ON prs.pr = cards.pr
    LEFT JOIN card_bodies AS bodies ON bodies.card_id = cards.card_id
    LEFT JOIN events AS own ON own.id = cards.event_id
    LEFT JOIN events AS merge ON merge.id = prs.event_id AND prs.state = '${MERGED}'
`

const RELEASE_MEMBERS = `
  SELECT card_releases.card_id AS card, card_releases.release FROM card_releases
  JOIN plans ON plans.plan_id = card_releases.release
  WHERE plans.state = ? ORDER BY card_releases.card_id
`

function markOf(row: CardRow): CardMark {
  if (row.state === MERGED || row.pr_state === MERGED)
    return 'delivered'
  if (DROPPED_STATES.has(row.state ?? '') || TERMINAL_LANES.has(row.lane ?? ''))
    return 'dropped'
  if (REVIEW_STATES.has(row.state ?? '') || REVIEW_QUEUES.has(row.queue ?? ''))
    return 'review'
  if (WORK_STATES.has(row.state ?? '') || WORK_QUEUES.has(row.queue ?? ''))
    return 'in_progress'
  return 'queued'
}

function cardReadings(db: BusDb): Map<number, CardReading> {
  const rows = db.prepare(CARD_READINGS).all() as unknown as CardRow[]
  return new Map(rows.map(row => [Number(row.id), { mark: markOf(row), at: row.at }] as const))
}

function gateOf(word: string | null, remainder: number): ReleaseGate | null {
  return word === null ? null : { word, status: remainder === 0 ? GATE_DUE : GATE_OPEN }
}

function progressOf(release: ReleaseRow, cards: readonly (readonly [number, CardReading])[], now: Date): PlanProgress {
  const stages = Object.fromEntries(RELEASE_STAGES.map(stage => [stage, 0])) as Record<ReleaseStage, number>
  let deliveredRecently = 0
  for (const [, reading] of cards) {
    if (reading.mark === DROPPED)
      continue
    stages[reading.mark] += 1
    if (reading.mark === 'delivered' && now.getTime() - Date.parse(reading.at ?? '') <= RECENT_HOURS * HOUR_MS)
      deliveredRecently += 1
  }
  const total = RELEASE_STAGES.reduce((sum, stage) => sum + stages[stage], 0)
  const remainder = total - stages.delivered
  return { id: release.id, title: release.title, goal: release.goal, delivered: stages.delivered, total, remainder, stages, cards: cards.map(([card, reading]) => ({ card, mark: reading.mark })), gate: gateOf(release.gate, remainder), deliveredRecently }
}

function backlogOf(db: BusDb, readings: Map<number, CardReading>, planned: Set<number>): number {
  const bodies = db.prepare('SELECT card_id AS id, lane FROM card_bodies').all() as unknown as { id: number, lane: string | null }[]
  return bodies.filter((body) => {
    const mark = readings.get(Number(body.id))?.mark ?? 'queued'
    return !planned.has(Number(body.id)) && !TERMINAL_LANES.has(body.lane ?? '') && mark !== 'delivered' && mark !== 'dropped'
  }).length
}

function holdsReleases(db: BusDb): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('plans', 'card_releases')`).all().length === 2
}

export function goalOf(db: BusDb, now: Date = new Date()): Goal | null {
  if (!holdsReleases(db))
    return null
  const releases = db.prepare('SELECT plan_id AS id, title, goal, gate FROM plans WHERE state = ? ORDER BY plan_id').all(OPEN_PLAN) as unknown as ReleaseRow[]
  if (releases.length === 0)
    return null
  const members = (db.prepare(RELEASE_MEMBERS).all(OPEN_PLAN) as unknown as { card: number, release: string }[]).map(member => ({ card: Number(member.card), release: member.release }))
  const readings = cardReadings(db)
  const reading = (card: number): CardReading => readings.get(card) ?? { mark: 'queued', at: null }
  return {
    plans: releases.map(release => progressOf(release, members.filter(member => member.release === release.id).map(member => [member.card, reading(member.card)] as const), now)),
    backlog: backlogOf(db, readings, new Set(members.map(member => member.card))),
  }
}

function gateWords(gate: ReleaseGate | null): string {
  return gate === null ? 'gate: not set' : `gate ${gate.word}: ${gate.status}`
}

export function planLine(plan: PlanProgress, backlog: number): string {
  return [
    `${plan.title}: ${MARK_WORDS.delivered} ${plan.delivered} of ${plan.total}`,
    ...LINE_STAGES.map(stage => `${MARK_WORDS[stage]} ${plan.stages[stage]}`),
    `remainder ${plan.remainder}`,
    gateWords(plan.gate),
    `+${plan.deliveredRecently} in ${RECENT_HOURS} h`,
    `backlog: ${backlog}`,
  ].join(' · ')
}

export function droppedLine(plan: PlanProgress, lore: Lore): string | null {
  const dropped = plan.cards.filter(card => card.mark === DROPPED)
  return dropped.length === 0 ? null : lore.boardReleaseDropped(dropped.map(card => `#${card.card}`))
}

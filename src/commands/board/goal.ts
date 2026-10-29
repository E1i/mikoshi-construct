import type { BusDb } from '../cost/bus.js'
import { CARD_ADMITTED, CARD_MOVED, OPEN_PLAN, TERMINAL_LANES } from '../../../scripts/core/events.js'

export const ITEM_STAGES = ['not_created', 'queued', 'in_progress', 'review', 'delivered'] as const
const RECENT_HOURS = 24
const HOUR_MS = 3_600_000
const BY_STAGE: readonly ItemStage[] = ['queued', 'in_progress', 'review']
const MERGED = 'merged'
const DROPPED_STATES = new Set(['dropped', 'closed'])
const REVIEW_STATES = new Set(['in_review', 'ready'])
const REVIEW_QUEUES = new Set(['review', 'merge'])
const WORK_STATES = new Set(['running', 'changes', 'stopped'])
const WORK_QUEUES = new Set(['answer'])

export type ItemStage = typeof ITEM_STAGES[number]
type CardMark = 'dropped' | 'queued' | 'in_progress' | 'review' | 'delivered'

export interface PlanProgress {
  id: string
  title: string
  goal: string
  delivered: number
  total: number
  stages: Record<ItemStage, number>
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

interface ItemRow {
  plan_id: string
  cards: string
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

function stageOf(cards: readonly CardReading[]): ItemStage {
  const live = cards.filter(card => card.mark !== 'dropped')
  const open = live.filter(card => card.mark !== 'delivered')
  if (live.length === 0)
    return 'not_created'
  if (open.length === 0)
    return 'delivered'
  if (open.every(card => card.mark === 'review'))
    return 'review'
  return live.some(card => card.mark !== 'queued') ? 'in_progress' : 'queued'
}

function deliveredAt(cards: readonly CardReading[]): number {
  return Math.max(...cards.filter(card => card.mark === 'delivered').map(card => Date.parse(card.at ?? '')))
}

function progressOf(plan: { id: string, title: string, goal: string }, items: readonly CardReading[][], now: Date): PlanProgress {
  const stages = Object.fromEntries(ITEM_STAGES.map(stage => [stage, 0])) as Record<ItemStage, number>
  let deliveredRecently = 0
  for (const cards of items) {
    const stage = stageOf(cards)
    stages[stage] += 1
    if (stage === 'delivered' && now.getTime() - deliveredAt(cards) <= RECENT_HOURS * HOUR_MS)
      deliveredRecently += 1
  }
  return { ...plan, delivered: stages.delivered, total: items.length, stages, deliveredRecently }
}

function backlogOf(db: BusDb, readings: Map<number, CardReading>, planned: Set<number>): number {
  const bodies = db.prepare('SELECT card_id AS id, lane FROM card_bodies').all() as unknown as { id: number, lane: string | null }[]
  return bodies.filter((body) => {
    const mark = readings.get(Number(body.id))?.mark ?? 'queued'
    return !planned.has(Number(body.id)) && !TERMINAL_LANES.has(body.lane ?? '') && mark !== 'delivered' && mark !== 'dropped'
  }).length
}

function holdsPlans(db: BusDb): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plans'`).get() !== undefined
}

export function goalOf(db: BusDb, now: Date = new Date()): Goal | null {
  if (!holdsPlans(db))
    return null
  const plans = db.prepare('SELECT plan_id AS id, title, goal FROM plans WHERE state = ? ORDER BY event_id').all(OPEN_PLAN) as unknown as { id: string, title: string, goal: string }[]
  if (plans.length === 0)
    return null
  const items = db.prepare('SELECT plan_items.plan_id, plan_items.cards FROM plan_items JOIN plans ON plans.plan_id = plan_items.plan_id WHERE plans.state = ? ORDER BY plan_items.item_id').all(OPEN_PLAN) as unknown as ItemRow[]
  const readings = cardReadings(db)
  const linked = items.map(item => ({ plan: item.plan_id, cards: JSON.parse(item.cards) as number[] }))
  const reading = (card: number): CardReading => readings.get(card) ?? { mark: 'queued', at: null }
  return {
    plans: plans.map(plan => progressOf(plan, linked.filter(item => item.plan === plan.id).map(item => item.cards.map(reading)), now)),
    backlog: backlogOf(db, readings, new Set(linked.flatMap(item => item.cards))),
  }
}

function itemStageWord(stage: ItemStage): string {
  return stage.replace('_', ' ')
}

export function planLine(plan: PlanProgress, backlog: number): string {
  return [
    `${plan.title}: delivered ${plan.delivered} of ${plan.total}`,
    ...BY_STAGE.map(stage => `${itemStageWord(stage)} ${plan.stages[stage]}`),
    `slices without cards: ${plan.stages.not_created}`,
    `+${plan.deliveredRecently} in ${RECENT_HOURS} h`,
    `backlog: ${backlog}`,
  ].join(' · ')
}

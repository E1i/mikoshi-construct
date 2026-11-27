import type { PlanRow } from '../../../scripts/core/plan-readings.js'
import type { Lore } from '../../ui/lore.js'
import type { BusDb } from '../cost/bus.js'
import { cardBodyLanes, cardsWithTheirLines, lanesOfCards, stampsAmong, tasksInStates } from '../../../scripts/core/card-readings.js'
import { OPEN_PLAN, TERMINAL_LANES } from '../../../scripts/core/events.js'
import { holdsPlans, plans, releases } from '../../../scripts/core/plan-readings.js'
import { all as allPrs } from '../../../scripts/core/pr-readings.js'

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

const OPEN_TASK_STATES = ['queued', 'leased']

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

function queuesOfCards(db: BusDb): Map<number, string> {
  const queues = new Map<number, string>()
  for (const task of tasksInStates(db, OPEN_TASK_STATES))
    queues.set(task.card_id, task.queue)
  return queues
}

function cardRows(db: BusDb): CardRow[] {
  const prs = new Map(allPrs(db).map(pr => [pr.pr, pr] as const))
  const queues = queuesOfCards(db)
  const lanes = lanesOfCards(db)
  const cards = cardsWithTheirLines(db).map((card) => {
    const pr = card.pr === null ? undefined : prs.get(card.pr)
    return { card, pr, mergedAt: pr?.state === MERGED ? [pr.event_id] : [] }
  })
  const stamps = stampsAmong(db, cards.flatMap(({ card, mergedAt }) => [card.event_id, ...mergedAt]))
  return cards.map(({ card, pr, mergedAt }) => ({
    id: card.id,
    state: card.state,
    pr_state: pr?.state ?? null,
    queue: queues.get(card.id) ?? null,
    lane: lanes.get(card.id) ?? null,
    at: mergedAt.map(id => stamps.get(id) ?? null).find(ts => ts !== null) ?? stamps.get(card.event_id) ?? null,
  }))
}

function cardReadings(db: BusDb): Map<number, CardReading> {
  return new Map(cardRows(db).map(row => [row.id, { mark: markOf(row), at: row.at }] as const))
}

function gateOf(word: string | null, remainder: number): ReleaseGate | null {
  return word === null ? null : { word, status: remainder === 0 ? GATE_DUE : GATE_OPEN }
}

function progressOf(release: PlanRow, cards: readonly (readonly [number, CardReading])[], now: Date): PlanProgress {
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
  return cardBodyLanes(db).filter((body) => {
    const mark = readings.get(body.card_id)?.mark ?? 'queued'
    return !planned.has(body.card_id) && !TERMINAL_LANES.has(body.lane ?? '') && mark !== 'delivered' && mark !== 'dropped'
  }).length
}

export function goalOf(db: BusDb, now: Date = new Date()): Goal | null {
  if (!holdsPlans(db))
    return null
  const open = plans.inState(db, OPEN_PLAN)
  if (open.length === 0)
    return null
  const members = releases.ofPlansIn(db, OPEN_PLAN)
  const readings = cardReadings(db)
  const reading = (card: number): CardReading => readings.get(card) ?? { mark: 'queued', at: null }
  return {
    plans: open.map(release => progressOf(release, members.filter(member => member.release === release.id).map(member => [member.card, reading(member.card)] as const), now)),
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

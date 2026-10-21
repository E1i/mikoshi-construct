import type { Lore } from '../../ui/lore.js'
import type { BusCard, BusFacts, BusMatrix } from './bus.js'
import { FLOW_STATES, LIVE_STATES, SHORT_SHA } from './bus.js'

const CARD_PREFIX = /^card:\s*/
const MATRIX_ROLE = 'matrix'
const BUS_ROLE = 'bus'
const GOAL_ROLE = 'goal'
const MINUTE_MS = 60_000
export const ENDED_SHOWN_HOURS = 12
const HOUR_MS = 3_600_000

function cardName(card: BusCard): string {
  return card.line === null ? `#${card.id}` : card.line.replace(CARD_PREFIX, '')
}

function flowName(card: BusCard): string {
  return `#${card.id}`
}

export function isLive(card: BusCard): boolean {
  return card.body && !card.closed && LIVE_STATES.includes(card.state ?? '')
}

function endedRecently(card: BusCard, at: string): boolean {
  const endedAt = card.closed ? card.closedAt : LIVE_STATES.includes(card.state ?? '') ? null : card.since
  if (endedAt === null)
    return false
  const age = Date.parse(at) - Date.parse(endedAt)
  return !Number.isNaN(age) && age <= ENDED_SHOWN_HOURS * HOUR_MS
}

export function flowLines(cards: BusCard[], lore: Lore): string[] {
  const live = cards.filter(isLive)
  return lore.boardFlowColumns.map((title, column) => lore.boardColumnLine(title, live.filter(card => FLOW_STATES[column]!.includes(card.state ?? '')).map(flowName)))
}

function lanesOf(cards: BusCard[]): (string | null)[] {
  const named = [...new Set(cards.flatMap(card => card.lane === null ? [] : [card.lane]))].sort()
  return cards.some(card => card.lane === null) ? [...named, null] : named
}

export function backlogCards(cards: BusCard[], at: string, all: boolean): BusCard[] {
  return all ? cards : cards.filter(card => isLive(card) || endedRecently(card, at))
}

export function backlogLines(cards: BusCard[], lore: Lore): string[] {
  return lanesOf(cards).flatMap((lane) => {
    const inLane = cards.filter(card => card.lane === lane)
    return [lore.boardLaneLine(lane ?? undefined, inLane.length), ...inLane.map(card => lore.boardBacklogRow(cardName(card), card.state ?? '—'))]
  })
}

export function servicesLines(facts: BusFacts, lore: Lore): string[] {
  if (facts.services.length === 0)
    return [lore.boardNoServices]
  return facts.services.map(service => lore.boardServiceLine(service.role, service.task, service.tree ?? undefined, service.step))
}

function matrixStep(matrix: BusMatrix): string {
  const counts = matrix.full === null ? `killed ${matrix.killed} \u00B7 survived ${matrix.survived} \u00B7 not run ${matrix.notRun}` : `full run: ${matrix.full}`
  return matrix.head === null ? counts : `${counts} @ ${matrix.head.slice(0, SHORT_SHA)}`
}

export function matrixLines(facts: BusFacts, lore: Lore): string[] {
  return facts.matrices.map(matrix => lore.boardServiceLine(MATRIX_ROLE, `PR #${matrix.pr}`, undefined, matrixStep(matrix)))
}

function minutesSince(ts: string, at: string): number {
  return Math.max(0, Math.round((Date.parse(at) - Date.parse(ts)) / MINUTE_MS))
}

export function pulseLines(facts: BusFacts, lore: Lore): string[] {
  const pulse = facts.pulse === null ? 'no pulse recorded' : `pulse ${minutesSince(facts.pulse, facts.at)} min ago`
  const used = facts.slots.length === 0 ? 'none in use' : facts.slots.map(slot => `${slot.queue} ${slot.used}`).join(', ')
  return [lore.boardServiceLine(BUS_ROLE, 'pulse', undefined, `${pulse} \u00B7 slots in use: ${used} (the bus records no capacity)`)]
}

export function goalLines(facts: BusFacts, lore: Lore): string[] {
  const { goal } = facts
  return goal === null ? [] : [lore.boardServiceLine(GOAL_ROLE, `release ${goal.release}`, undefined, `${goal.done} of ${goal.total} merged`)]
}

export interface Screen {
  title: string
  lines: string[]
}

export interface Screens {
  screens: Screen[]
  footer: string
}

export function boardScreens(facts: BusFacts, lore: Lore, all = false): Screens {
  return {
    screens: [
      { title: lore.boardTabFlow, lines: [...goalLines(facts, lore), ...flowLines(facts.cards, lore)] },
      { title: lore.boardTabBacklog, lines: backlogLines(backlogCards(facts.cards, facts.at, all), lore) },
      { title: lore.boardTabServices, lines: [...servicesLines(facts, lore), ...pulseLines(facts, lore), ...matrixLines(facts, lore)] },
    ],
    footer: lore.boardFooter(facts.services.length, facts.failure ?? undefined, facts.reviewQueue),
  }
}

export function screenLines(facts: BusFacts, lore: Lore, all = false): string[] {
  const { screens, footer } = boardScreens(facts, lore, all)
  return [...screens.flatMap(screen => [screen.title, ...screen.lines]), footer]
}

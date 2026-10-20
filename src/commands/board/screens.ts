import type { Lore } from '../../ui/lore.js'
import type { BusCard, BusFacts, BusMatrix } from './bus.js'
import { SHORT_SHA } from './bus.js'

const FLOW_STATES = [['queued'], ['running', 'changes'], ['in_review'], ['ready']]
const CARD_PREFIX = /^card:\s*/
const MATRIX_ROLE = 'matrix'

function cardName(card: BusCard): string {
  return card.line === null ? `#${card.id}` : card.line.replace(CARD_PREFIX, '')
}

export function flowLines(cards: BusCard[], lore: Lore): string[] {
  return lore.boardFlowColumns.map((title, column) => lore.boardColumnLine(title, cards.filter(card => FLOW_STATES[column]!.includes(card.state ?? '')).map(card => `#${card.id}`)))
}

function lanesOf(cards: BusCard[]): (string | null)[] {
  const named = [...new Set(cards.flatMap(card => card.lane === null ? [] : [card.lane]))].sort()
  return cards.some(card => card.lane === null) ? [...named, null] : named
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

export function screenLines(facts: BusFacts, lore: Lore): string[] {
  return [
    lore.boardTabFlow,
    ...flowLines(facts.cards, lore),
    lore.boardTabBacklog,
    ...backlogLines(facts.cards, lore),
    lore.boardTabServices,
    ...servicesLines(facts, lore),
    ...matrixLines(facts, lore),
    lore.boardFooter(facts.services.length, facts.failure ?? undefined, facts.reviewQueue),
  ]
}

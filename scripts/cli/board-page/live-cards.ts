import type { BusCard } from '../../../src/commands/board/bus.js'

export const MERGED_SHOWN_HOURS = 24
export const BOARD_HISTORY_FILE = 'board-history.html'
const HOUR_MS = 3_600_000

function mergedWithin(card: BusCard, at: string): boolean {
  const mergedAt = card.closedAt ?? card.since
  const age = mergedAt === null ? Number.NaN : Date.parse(at) - Date.parse(mergedAt)
  return !Number.isNaN(age) && age <= MERGED_SHOWN_HOURS * HOUR_MS
}

function onThePage(card: BusCard, at: string): boolean {
  if (card.stage === 'merged')
    return mergedWithin(card, at)
  return card.stage !== 'dropped' && !card.closed
}

export function liveCardsOf(cards: readonly BusCard[], at: string): BusCard[] {
  const shown = new Set(cards.filter(card => onThePage(card, at)).map(card => card.id))
  const openTasks = new Set(cards.flatMap(card => shown.has(card.id) && card.parent !== undefined ? [card.parent.card] : []))
  return cards.filter(card => shown.has(card.id) || (card.parent !== undefined && openTasks.has(card.parent.card)))
}

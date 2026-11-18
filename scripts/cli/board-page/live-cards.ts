import type { BusCard } from '../../../src/commands/board/bus.js'

export const MERGED_SHOWN_HOURS = 24
export const BOARD_HISTORY_FILE = 'board-history.html'
export const LIVE_FILTER = 'live'
export const FILTER_ATTRIBUTE = 'data-filter'
const HOUR_MS = 3_600_000
const NO_REASON = 'the hold names no reason'

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

export interface HoldEvent {
  id: number
  card: number | null
  fields: { readonly reason?: unknown, readonly takeover?: unknown }
}

type HoldLayer = 'owner' | 'takeover'

function latestLayer(layers: Map<HoldLayer, { id: number, reason: string }>): HoldLayer | null {
  const [owner, takeover] = [layers.get('owner'), layers.get('takeover')]
  if (owner === undefined)
    return takeover === undefined ? null : 'takeover'
  return takeover === undefined || owner.id > takeover.id ? 'owner' : 'takeover'
}

export function ownerHolds(held: readonly HoldEvent[], released: readonly HoldEvent[]): Map<number, string> {
  const releases = new Set(released.map(event => event.id))
  const cards = new Map<number, Map<HoldLayer, { id: number, reason: string }>>()
  for (const event of [...held, ...released].sort((a, b) => a.id - b.id)) {
    if (event.card === null)
      continue
    const layers = cards.get(event.card) ?? new Map<HoldLayer, { id: number, reason: string }>()
    cards.set(event.card, layers)
    const latest = latestLayer(layers)
    if (releases.has(event.id)) {
      if (latest !== null)
        layers.delete(latest)
      continue
    }
    const layer: HoldLayer = event.fields.takeover == null ? 'owner' : 'takeover'
    const reason = typeof event.fields.reason === 'string' && event.fields.reason !== '' ? event.fields.reason : NO_REASON
    layers.set(layer, { id: layers.get(layer)?.id ?? event.id, reason })
  }
  return new Map([...cards].flatMap(([card, layers]) => latestLayer(layers) === 'owner' ? [[card, layers.get('owner')!.reason] as const] : []))
}

export function filterId(filter: string): string {
  return `show-${filter.replace(/\W/g, '_')}`
}

export function filterRule(filter: string): string {
  const id = filterId(filter)
  const shown = filter === LIVE_FILTER ? '[data-live]' : `[data-stage="${filter.replace(/["\\<>]/g, '')}"]`
  return `.backlog[${FILTER_ATTRIBUTE}="${id}"] { & tr[data-card]:not(${shown}), & tbody:not(:has(tr${shown})) { display: none; } & .chip[href="#${id}"] { --_bg: var(--wire); --_fg: var(--void); --_bd: var(--wire); } }`
}

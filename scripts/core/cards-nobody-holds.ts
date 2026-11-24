import type { DatabaseSync } from 'node:sqlite'
import { cardsAmong, cardsWithAState } from './card-readings.js'
import { BY_CARD, EITHER_JOURNAL, lastPer } from './events-query.js'
import { mergedCards } from './pr-readings.js'
import { all as allTasks } from './tasks-query.js'

export interface CardNobodyHolds {
  card: number
  state: string
  pr: number | null
  lastEvent: { id: number, type: string, ts: string }
}

const LIVE_TASK_STATES: readonly string[] = ['queued', 'leased']

export function cardsNobodyHolds(db: DatabaseSync, heldElsewhere: readonly string[], ignoredActor: string): CardNobodyHolds[] {
  const merged = new Set(mergedCards(db))
  const tasked = new Set(allTasks(db).filter(task => LIVE_TASK_STATES.includes(task.state)).map(task => task.card_id))
  const lastOf = new Map(lastPer(db, BY_CARD, { notBy: ignoredActor, withCard: true, legacy: EITHER_JOURNAL }).map(event => [event.card_id, event]))
  const candidates = [...cardsWithAState(db)].filter(([card, state]) => !heldElsewhere.includes(state) && !merged.has(card) && !tasked.has(card) && lastOf.has(card)).map(([card]) => card)
  const cards = cardsAmong(db, candidates)
  return candidates.sort((a, b) => a - b).map((card) => {
    const last = lastOf.get(card)!
    return { card, state: cards.get(card)!.state!, pr: cards.get(card)!.pr, lastEvent: { id: last.id, type: last.type, ts: last.ts } }
  })
}

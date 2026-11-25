import type { DatabaseSync } from 'node:sqlite'
import { all } from './pr-readings.js'

export interface MergeEvent {
  event: 'merge'
  task: string
  pr?: number
  merged?: string
  by: string
  commit: string
  ts: string
}

export function prsByCard(db: DatabaseSync): Map<number, ReadonlySet<number>> {
  const byCard = new Map<number, Set<number>>()
  for (const { pr, card_id } of all(db)) {
    if (card_id !== null)
      byCard.set(card_id, (byCard.get(card_id) ?? new Set<number>()).add(pr))
  }
  return byCard
}

import type { DatabaseSync } from 'node:sqlite'
import type { EventRow } from '../core/events-query.js'
import { cardStatesAmong, prioritiesAmong } from '../core/card-readings.js'
import { latest } from '../core/events-query.js'
import { CARD_STARTED } from '../core/events.js'
import { open } from '../core/pr-readings.js'
import { ciWord } from '../ports/ci-reading.js'

export const STARTER_ACTOR = 'worker:start:'

export interface WindowPr {
  pr: number
  cardId: number
  head: string | null
  ci: string | null
  cardState: string | null
  priority: string | null
}

export function startedByTheWindow(started: EventRow | null): boolean {
  return started !== null && (started.actor ?? '').startsWith(STARTER_ACTOR) && (started.data?.shift ?? null) === null
}

export function windowOpenPrs(db: DatabaseSync): WindowPr[] {
  const prs = open(db).flatMap(pr => pr.card_id !== null && startedByTheWindow(latest(db, { card: pr.card_id, types: [CARD_STARTED] })) ? [{ ...pr, card_id: pr.card_id }] : [])
  const cards = prs.map(pr => pr.card_id)
  const states = cardStatesAmong(db, cards)
  const priorities = prioritiesAmong(db, cards)
  return prs.map(pr => ({ pr: pr.pr, cardId: pr.card_id, head: pr.head, ci: ciWord(pr.ci), cardState: states.get(pr.card_id) ?? null, priority: priorities.get(pr.card_id) ?? null }))
}

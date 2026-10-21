import type { DatabaseSync } from 'node:sqlite'
import { CARD_STARTED } from '../core/events.js'

export const STARTER_ACTOR = 'worker:start:'

export interface WindowPr {
  pr: number
  cardId: number
  head: string | null
  ci: string | null
  cardState: string | null
  priority: string | null
}

const WINDOW_OPEN_PRS = `
  SELECT prs.pr, prs.card_id, prs.head, prs.ci, cards.state AS card_state, card_bodies.priority FROM prs
  JOIN events started ON started.id = (SELECT max(id) FROM events WHERE card_id = prs.card_id AND type = '${CARD_STARTED}' AND legacy = 0)
  LEFT JOIN cards ON cards.card_id = prs.card_id
  LEFT JOIN card_bodies ON card_bodies.card_id = prs.card_id
  WHERE prs.state = 'open' AND started.actor LIKE '${STARTER_ACTOR}%' AND json_extract(started.payload, '$.shift') IS NULL
  ORDER BY prs.pr
`

interface WindowPrRow {
  pr: number
  card_id: number
  head: string | null
  ci: string | null
  card_state: string | null
  priority: string | null
}

export function windowOpenPrs(db: DatabaseSync): WindowPr[] {
  return (db.prepare(WINDOW_OPEN_PRS).all() as unknown as WindowPrRow[]).map(row => ({ pr: Number(row.pr), cardId: Number(row.card_id), head: row.head, ci: row.ci, cardState: row.card_state, priority: row.priority }))
}

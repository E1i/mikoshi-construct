import type { DatabaseSync } from 'node:sqlite'

export interface PlanOfCard {
  plan: string
  state: string
}

const RELEASE_OF_CARD = 'SELECT release FROM card_releases WHERE card_id = ?'
const PLAN_STATE = 'SELECT state FROM plans WHERE plan_id = ?'

export const releases = {
  ofCard(db: DatabaseSync, cardId: number): string | null {
    const release = (db.prepare(RELEASE_OF_CARD).get(cardId) as { release: string } | undefined)?.release
    return release === undefined ? null : String(release)
  },
}

export const plans = {
  ofCard(db: DatabaseSync, cardId: number): PlanOfCard | null {
    const plan = releases.ofCard(db, cardId)
    if (plan === null)
      return null
    const row = db.prepare(PLAN_STATE).get(plan) as { state: string } | undefined
    return row === undefined ? null : { plan, state: String(row.state) }
  },
}

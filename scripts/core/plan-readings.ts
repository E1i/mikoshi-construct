import type { DatabaseSync } from 'node:sqlite'

export interface PlanOfCard {
  plan: string
  state: string
}

export interface PlanRow {
  id: string
  title: string
  goal: string
  gate: string | null
}

export interface PlanMember {
  card: number
  release: string
}

const RELEASE_OF_CARD = 'SELECT release FROM card_releases WHERE card_id = ?'
const PLAN_STATE = 'SELECT state FROM plans WHERE plan_id = ?'
const PLANS_IN_STATE = 'SELECT plan_id AS id, title, goal, gate FROM plans WHERE state = ? ORDER BY plan_id'
const MEMBERS_OF_PLANS_IN_STATE = `
  SELECT card_releases.card_id AS card, card_releases.release FROM card_releases
  JOIN plans ON plans.plan_id = card_releases.release
  WHERE plans.state = ? ORDER BY card_releases.card_id
`
const CARDS_OF_PLAN_ITEMS = 'SELECT cards FROM plan_items WHERE plan_id = ? ORDER BY item_id'
const PLAN_TABLES = ['plans', 'card_releases']
const TABLES_PRESENT = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (SELECT value FROM json_each(?))`

export function holdsPlans(db: DatabaseSync): boolean {
  return db.prepare(TABLES_PRESENT).all(JSON.stringify(PLAN_TABLES)).length === PLAN_TABLES.length
}

export const releases = {
  ofCard(db: DatabaseSync, cardId: number): string | null {
    const release = (db.prepare(RELEASE_OF_CARD).get(cardId) as { release: string } | undefined)?.release
    return release === undefined ? null : String(release)
  },
  ofPlansIn(db: DatabaseSync, state: string): PlanMember[] {
    const rows = db.prepare(MEMBERS_OF_PLANS_IN_STATE).all(state) as { card: number, release: string }[]
    return rows.map(row => ({ card: Number(row.card), release: String(row.release) }))
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
  inState(db: DatabaseSync, state: string): PlanRow[] {
    return db.prepare(PLANS_IN_STATE).all(state) as unknown as PlanRow[]
  },
  linkedCards(db: DatabaseSync, plan: string): number[] {
    const items = db.prepare(CARDS_OF_PLAN_ITEMS).all(plan) as { cards: string }[]
    return [...new Set(items.flatMap(item => JSON.parse(item.cards) as number[]))].sort((a, b) => a - b)
  },
}

import type { BusDb } from '../cost/bus.js'

export const GOAL_DECISION = 193
const MERGED_CARD = 'merged'
const DROPPED_CARD = 'dropped'
const RELEASE = /\d+\.\d+/
const PATH_LINE = /^Path \(D-76\):.*$/gm

export interface Goal {
  release: string
  done: number
  total: number
}

function namesRelease(text: string, release: string): boolean {
  const named = new RegExp(`(?<![\\d.])${release.replace('.', '\\.')}(?!\\.?\\d)`)
  return (text.match(PATH_LINE) ?? []).some(line => named.test(line))
}

export function goalOf(db: BusDb): Goal | null {
  const decision = db.prepare('SELECT text FROM decisions WHERE decision_id = ?').get(GOAL_DECISION) as { text: string } | undefined
  const release = decision?.text.match(RELEASE)?.[0]
  if (release === undefined)
    return null
  const cards = (db.prepare('SELECT body.text, cards.state FROM card_bodies AS body LEFT JOIN cards ON cards.card_id = body.card_id').all() as { text: string, state: string | null }[])
    .filter(card => card.state !== DROPPED_CARD && namesRelease(card.text, release))
  return { release, done: cards.filter(card => card.state === MERGED_CARD).length, total: cards.length }
}

import type { DatabaseSync } from 'node:sqlite'
import type { InForceDecision } from './decisions.js'
import { lapsed, termOf } from '../decisions/decisions.js'
import { inForceDecisions } from './decisions.js'

export const SHARD_ISSUED = 'shard.issued'
export const SHARD_USED = 'shard.used'

export interface UnspentShard {
  id: string
  under: number | null
}

export function decisionsInForceAt(db: DatabaseSync, now: Date): InForceDecision[] {
  return inForceDecisions(db).filter(decision => !lapsed(termOf(decision.text), now))
}

export function shardActive(db: DatabaseSync, run: string | null): boolean {
  if (run === null)
    return false
  return db.prepare(`SELECT 1 FROM events WHERE type = '${SHARD_USED}' AND json_extract(payload, '$.run') = ? LIMIT 1`).get(run) !== undefined
}

export function unspentShardsOf(card: string, pr: string): string {
  return `
  SELECT issued.id AS event_id, json_extract(issued.payload, '$.id') AS id, json_extract(issued.payload, '$.under') AS under FROM events issued
  WHERE issued.type = '${SHARD_ISSUED}' AND (issued.card_id = ${card} OR issued.pr = ${pr})
    AND NOT EXISTS (SELECT 1 FROM events used WHERE used.type = '${SHARD_USED}' AND json_extract(used.payload, '$.id') = json_extract(issued.payload, '$.id'))
`
}

function covers(under: unknown, decisions: readonly InForceDecision[]): under is number | null {
  return under === null || (typeof under === 'number' && decisions.some(decision => decision.decisionId === under))
}

export function unspentShard(db: DatabaseSync, cardId: number, pr: number | null, decisions: readonly InForceDecision[] = []): UnspentShard | null {
  const rows = db.prepare(`${unspentShardsOf('?', '?')} ORDER BY issued.id`).all(cardId, pr) as { id: unknown, under: unknown }[]
  for (const row of rows) {
    if (typeof row.id === 'string' && covers(row.under, decisions))
      return { id: row.id, under: row.under }
  }
  return null
}

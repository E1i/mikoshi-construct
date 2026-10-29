import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import type { InForceDecision } from './decisions.js'
import { SHARD_EXPIRED, SHARD_ISSUED, SHARD_REVOKED, SHARD_USED } from '../core/events.js'
import { inForceDecisions } from './decisions.js'
import { lapsed, OWNER_SOURCE, termOf } from './decisions/decisions.js'

export const WINDOW_SHARD_HOURS = 6
export const DECISIONS_SCOPE = 'merge+decisions'
export const WINDOW_SCOPES = ['merge', DECISIONS_SCOPE] as const
export const VERSION_PR_RESERVATION = 'version-pr'
export const OWNERS_UNDER_ANY_SHARD: Readonly<Record<string, RegExp>> = {
  [VERSION_PR_RESERVATION]: /version pull request|changeset-release|chore: version packages/i,
  'npm-stage': /\bnpm\b/i,
  'security-invariants': /security-invariants/i,
}
export const OWNERS_OF_A_STOP: Readonly<Record<string, RegExp>> = {
  ...OWNERS_UNDER_ANY_SHARD,
  'claude-config': /(?:^|[^\w.])\.claude\//,
  'owner-merges': /owner-merges/i,
  'workflows': /\.github\/workflows/i,
  'dropped-witness': /\b(?:drop|dropp(?:ed|ing)|remov(?:e|ed|ing))\s[^.?!]*witness|witness(?:es)?\s[^.?!]*\b(?:dropped|removed)\b/i,
}

export type WindowScope = typeof WINDOW_SCOPES[number]

export interface UnspentShard {
  id: string
  under: number | null
}

export interface WindowShard {
  id: string
  by: string
  scope: WindowScope
  until: string
}

const UNENDED_WINDOW_SHARDS = `
  SELECT issued.id AS event_id, json_extract(issued.payload, '$.id') AS id, json_extract(issued.payload, '$.by') AS by,
    json_extract(issued.payload, '$.scope') AS scope, json_extract(issued.payload, '$.until') AS until
  FROM events issued
  WHERE issued.type = '${SHARD_ISSUED}' AND json_extract(issued.payload, '$.window') = 1
    AND NOT EXISTS (SELECT 1 FROM events ended WHERE ended.type IN ('${SHARD_REVOKED}', '${SHARD_EXPIRED}') AND json_extract(ended.payload, '$.id') = json_extract(issued.payload, '$.id'))
`

const WINDOW_SHARDS = `${UNENDED_WINDOW_SHARDS} ORDER BY issued.id DESC`

export const WINDOW_SHARDS_LIVE_AT = `${UNENDED_WINDOW_SHARDS} AND json_extract(issued.payload, '$.until') > ?`

export function isWindowScope(value: unknown): value is WindowScope {
  return WINDOW_SCOPES.includes(value as WindowScope)
}

function unendedWindowShards(db: DatabaseSync): WindowShard[] {
  return (db.prepare(WINDOW_SHARDS).all() as Record<string, unknown>[]).flatMap(row =>
    typeof row.id === 'string' && typeof row.by === 'string' && isWindowScope(row.scope) && typeof row.until === 'string'
      ? [{ id: row.id, by: row.by, scope: row.scope, until: row.until }]
      : [])
}

export function activeWindowShards(db: DatabaseSync, now: Date): WindowShard[] {
  return unendedWindowShards(db).filter(shard => Date.parse(shard.until) > now.getTime())
}

export function activeDecisionsShard(db: DatabaseSync, now: Date): WindowShard | null {
  return activeWindowShards(db, now).find(shard => shard.scope === DECISIONS_SCOPE) ?? null
}

function reservedBy(reservations: Readonly<Record<string, RegExp>>, question: string): string | null {
  return Object.entries(reservations).find(([, words]) => words.test(question))?.[0] ?? null
}

export function ownersUnderAnyShard(question: string): string | null {
  return reservedBy(OWNERS_UNDER_ANY_SHARD, question)
}

export function ownersOfAStop(question: string): string | null {
  return reservedBy(OWNERS_OF_A_STOP, question)
}

export function cardDecisionCommand(cardId: number): string {
  return `pnpm decisions:add --card #${cardId} "${OWNER_SOURCE} <decision>"`
}

export function windowShardEnded(type: typeof SHARD_REVOKED | typeof SHARD_EXPIRED, actor: string, id: string, now: Date): BusEvent {
  return { ts: now.toISOString(), type, actor, cardId: null, pr: null, head: null, dedupeKey: `${type}:${id}`, payload: { id }, legacy: false }
}

export function expiredWindowShards(db: DatabaseSync, now: Date, actor: string): BusEvent[] {
  return unendedWindowShards(db).filter(shard => Date.parse(shard.until) <= now.getTime()).map(shard => windowShardEnded(SHARD_EXPIRED, actor, shard.id, now))
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

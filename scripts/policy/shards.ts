import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../core/db.js'
import type { InForceDecision } from './decisions/index.js'
import { SHARD_EXPIRED, SHARD_ISSUED, SHARD_REVOKED, SHARD_USED } from '../core/events.js'
import { decisionCommand, lapsed, termOf, visibleToCard } from './decisions/decisions.js'
import { inForceDecisions } from './decisions/index.js'
import { OWNER_EVEN_UNDER_THE_DECISION } from './policy.js'

export const WINDOW_SHARD_HOURS = 6
export const DECISIONS_SCOPE = 'merge+decisions'
export const WINDOW_SCOPES = ['merge', DECISIONS_SCOPE] as const
export const VERSION_PR_RESERVATION = 'version-pr'
export const DROPPED_WITNESS = 'dropped-witness'
export const WITNESS_MOVED = 'witness-moved'
export const AGENT_QUESTION = 'agent-question'
export const OWNER_DECIDES = 'owner'
export const WINDOW_DECIDES = 'window'

export type StopDecider = typeof OWNER_DECIDES | typeof WINDOW_DECIDES

export interface StopKind {
  risk: string
  underAnyShard: boolean
  asks: (question: string) => boolean
}

const SENTENCE_END = /(?<=[.?!;])\s+/
const DROPS_A_WITNESS = /\b(?:drop|dropp(?:ed|ing)|remov(?:e|ed|ing))\s[^.?!]*witness|witness(?:es)?\s[^.?!]*\b(?:dropped|removed)\b/i
const WITNESS_REF = String.raw`(?:(?:the\s+)?witness(?:es)?(?:\s+W\d+)?|W\d+)`
const TO_ANOTHER_CARD = String.raw`(?:to|into)\s+(?:another\s+card|(?:card\s+)?#\d+|(?:the\s+)?node-contract-suite)\b`
const OFF_THIS_CARD = String.raw`(?:(?:removed|dropped|taken)\s+(?:from|off)\s+(?:this|the)\s+card\s+and\s+)?`
const BEING = String.raw`(?:(?:is|was|are|were|gets|got|has\s+been|have\s+been)\s+)?`
const MOVES_THE_WITNESS = new RegExp(String.raw`\b(?:mov(?:e|es|ing)|transfer(?:s|ring)?|carr(?:y|ies|ying))\s+${WITNESS_REF}\s+${TO_ANOTHER_CARD}`, 'i')
const THE_WITNESS_IS_MOVED = new RegExp(String.raw`\b${WITNESS_REF}\s+${BEING}${OFF_THIS_CARD}(?:moved|transferred|carried)\s+${TO_ANOTHER_CARD}`, 'i')
const NEGATES = /\b(?:not|never|no|nor|cannot)\b|n't\b/i
const WITNESS_ID = /\bW\d+\b/g
const WITNESS_WORD = /\bwitness(?:es)?\b/gi

function namesOneWitness(sentence: string): boolean {
  const ids = new Set(sentence.match(WITNESS_ID) ?? [])
  return ids.size === 1 || (ids.size === 0 && (sentence.match(WITNESS_WORD) ?? []).length === 1)
}

function sentencesOf(question: string): string[] {
  return question.split(SENTENCE_END)
}

function movesAWitness(sentence: string): boolean {
  return (MOVES_THE_WITNESS.test(sentence) || THE_WITNESS_IS_MOVED.test(sentence)) && !NEGATES.test(sentence) && namesOneWitness(sentence)
}

export function witnessDropped(question: string): boolean {
  return sentencesOf(question).some(sentence => DROPS_A_WITNESS.test(sentence) && !movesAWitness(sentence))
}

export function witnessMoved(question: string): boolean {
  return sentencesOf(question).some(movesAWitness)
}

function says(words: RegExp): (question: string) => boolean {
  return question => words.test(question)
}

export const STOP_KINDS: Readonly<Record<string, StopKind>> = {
  [VERSION_PR_RESERVATION]: { risk: 'R1', underAnyShard: true, asks: says(/version pull request|changeset-release|chore: version packages/i) },
  'npm-stage': { risk: 'R1', underAnyShard: true, asks: says(/\bnpm\b/i) },
  'security-invariants': { risk: 'R1', underAnyShard: true, asks: says(/security-invariants/i) },
  'claude-config': { risk: 'R1', underAnyShard: false, asks: says(/(?:^|[^\w.])\.claude\//) },
  'owner-merges': { risk: 'R1', underAnyShard: false, asks: says(/owner-merges/i) },
  'workflows': { risk: 'R1', underAnyShard: false, asks: says(/\.github\/workflows/i) },
  [DROPPED_WITNESS]: { risk: 'R1', underAnyShard: false, asks: witnessDropped },
  [WITNESS_MOVED]: { risk: 'R4', underAnyShard: false, asks: witnessMoved },
  'outside-touches': { risk: 'R3', underAnyShard: false, asks: says(/\b(?:outside|not in) the touches\b/i) },
  [AGENT_QUESTION]: { risk: 'R3', underAnyShard: false, asks: () => true },
}

export function deciderOf(kind: StopKind): StopDecider {
  return kind.risk === OWNER_EVEN_UNDER_THE_DECISION ? OWNER_DECIDES : WINDOW_DECIDES
}

export const STOP_DECIDERS_UNDER_A_SHARD: Readonly<Record<string, StopDecider>> = Object.fromEntries(
  Object.entries(STOP_KINDS).map(([name, kind]) => [name, deciderOf(kind)]),
)

function kindsWhere(keep: (kind: StopKind) => boolean): Readonly<Record<string, StopKind>> {
  return Object.fromEntries(Object.entries(STOP_KINDS).filter(([, kind]) => keep(kind)))
}

export const OWNERS_OF_A_STOP = kindsWhere(kind => deciderOf(kind) === OWNER_DECIDES)
export const OWNERS_UNDER_ANY_SHARD = kindsWhere(kind => deciderOf(kind) === OWNER_DECIDES && kind.underAnyShard)

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

function reservedBy(kinds: Readonly<Record<string, StopKind>>, question: string): string | null {
  return Object.entries(kinds).find(([, kind]) => kind.asks(question))?.[0] ?? null
}

export function ownersUnderAnyShard(question: string): string | null {
  return reservedBy(OWNERS_UNDER_ANY_SHARD, question)
}

export function ownersOfAStop(question: string): string | null {
  return reservedBy(OWNERS_OF_A_STOP, question)
}

export function stopKindOf(question: string): string {
  return ownersOfAStop(question) ?? reservedBy(STOP_KINDS, question) ?? AGENT_QUESTION
}

export function deciderUnderAShard(question: string): StopDecider {
  return STOP_DECIDERS_UNDER_A_SHARD[stopKindOf(question)] ?? WINDOW_DECIDES
}

export function cardDecisionCommand(cardId: number): string {
  return decisionCommand('<decision>', [cardId])
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

export function cardDecisionLines(db: DatabaseSync, cardId: number, now: Date): string[] {
  return decisionsInForceAt(db, now)
    .filter(decision => visibleToCard(decision, cardId))
    .map(decision => `D-${decision.decisionId}: ${decision.text}`)
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

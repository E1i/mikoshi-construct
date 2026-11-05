import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from '../core/stored.js'
import type { DecisionRow } from './decisions/decisions.js'
import { cardReleased, CLOSED_CARD, MERGED_CARD, STOPPED_CARD } from '../core/card-automaton.js'
import { appendEvent, DECISION_ARCHIVED, DECISION_IN_FORCE } from '../core/db.js'
import { CARD_STOPPED, DECISION_RECORDED, DECISIONS_IMPORTED, QUESTION_OWNER } from '../core/events.js'
import { OWNER } from '../core/inbox.js'
import { NETWATCH } from '../core/observations.js'
import { payloadOf, reject } from '../core/stored.js'
import { termOf } from './decisions/decisions.js'

export const OWNER_DECISIONS_FILE = 'owner-decisions.md'
export const DECISION_EXPIRED = 'decision.expired'
export const DECISIONS_PROJECTED = 'decisions.projected'

export interface InForceDecision {
  decisionId: number
  text: string
  cards: number[]
}

export interface OwnerDecision {
  ts: string
  decisionId: number
  text: string
  cards: number[]
  supersedes?: number[]
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function recordDecision(db: DatabaseSync, decision: OwnerDecision): void {
  const dedupeKey = `${DECISION_RECORDED}:${decision.decisionId}`
  const written = appendEvent(db, {
    ts: decision.ts,
    type: DECISION_RECORDED,
    actor: OWNER,
    cardId: null,
    pr: null,
    head: null,
    dedupeKey,
    payload: { decision_id: decision.decisionId, text: decision.text, scope: decision.cards, source: OWNER, ...(decision.supersedes === undefined || decision.supersedes.length === 0 ? {} : { supersedes: decision.supersedes }) },
    legacy: false,
  })
  if (!written)
    throw new Error(`${dedupeKey} is already in the bus`)
}

function actorOf(db: DatabaseSync, event: StoredEvent): string | null {
  return (db.prepare('SELECT actor FROM events WHERE id = ?').get(event.id) as { actor: string | null }).actor
}

function lastStopReason(db: DatabaseSync, cardId: number, before: number): unknown {
  const row = db.prepare(`
    SELECT json_extract(payload, '$.reason') AS reason FROM events
    WHERE legacy = 0 AND type = '${CARD_STOPPED}' AND card_id = ? AND id < ?
    ORDER BY id DESC LIMIT 1
  `).get(cardId, before) as { reason: unknown } | undefined
  return row?.reason
}

function cardState(db: DatabaseSync, cardId: number): string | null | undefined {
  return (db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string | null } | undefined)?.state
}

function answerQuestions(db: DatabaseSync, cards: readonly number[], eventId: number): void {
  for (const cardId of cards) {
    if (cardState(db, cardId) === STOPPED_CARD && lastStopReason(db, cardId, eventId) === QUESTION_OWNER)
      cardReleased(db, cardId, eventId)
  }
}

function numbersOf(payload: Record<string, unknown>, field: string): number[] {
  const numbers = payload[field]
  return Array.isArray(numbers) && numbers.every(isPositiveInteger) ? numbers : reject(`${field} is not a list of numbers`)
}

function scopeOf(payload: Record<string, unknown>): number[] {
  return numbersOf(payload, 'scope')
}

function archive(db: DatabaseSync, decisionId: number): void {
  db.prepare(`UPDATE decisions SET state = '${DECISION_ARCHIVED}' WHERE decision_id = ?`).run(decisionId)
}

export function archiveSpentDecisions(db: DatabaseSync): void {
  db.exec(`
    UPDATE decisions SET state = '${DECISION_ARCHIVED}'
    WHERE state = '${DECISION_IN_FORCE}' AND json_array_length(coalesce(scope, '[]')) > 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(decisions.scope) AS named
        WHERE named.value NOT IN (SELECT card_id FROM cards WHERE state IN ('${MERGED_CARD}', '${CLOSED_CARD}'))
      )
  `)
}

function foldDecisionRecorded(db: DatabaseSync, event: StoredEvent): void {
  const actor = actorOf(db, event)
  if (actor !== OWNER)
    reject(`${DECISION_RECORDED} is the owner's, not ${actor}'s`)
  const payload = payloadOf(event)
  if (payload.source !== OWNER)
    reject(`source is not ${OWNER}`)
  const decisionId = isPositiveInteger(payload.decision_id) ? payload.decision_id : reject('decision_id is not a positive integer')
  const text = typeof payload.text === 'string' && payload.text.trim() !== '' ? payload.text : reject('text is empty')
  const cards = scopeOf(payload)
  const supersedes = payload.supersedes === undefined ? [] : numbersOf(payload, 'supersedes')
  if (db.prepare('SELECT 1 FROM decisions WHERE decision_id = ?').get(decisionId) !== undefined)
    reject(`D-${decisionId} is already recorded`)
  db.prepare('INSERT INTO decisions (decision_id, text, scope, source, event_id, until, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(decisionId, text, JSON.stringify(cards), OWNER, event.id, termOf(text).until, JSON.stringify(supersedes))
  for (const target of supersedes)
    archive(db, target)
  answerQuestions(db, cards, event.id)
  archiveSpentDecisions(db)
}

function importedOf(entry: unknown): InForceDecision {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
    reject('a decision is not an object')
  const fields = entry as Record<string, unknown>
  return {
    decisionId: isPositiveInteger(fields.decision_id) ? fields.decision_id : reject('decision_id is not a positive integer'),
    text: typeof fields.text === 'string' && fields.text.trim() !== '' ? fields.text : reject('text is empty'),
    cards: scopeOf(fields),
  }
}

function sameDecision(held: InForceDecision | undefined, imported: InForceDecision): boolean {
  return held !== undefined && held.text === imported.text && JSON.stringify(held.cards) === JSON.stringify(imported.cards)
}

function theBusProjectsTheFileSince(db: DatabaseSync, eventId: number): boolean {
  return db.prepare(`SELECT 1 FROM events WHERE type = '${DECISIONS_PROJECTED}' AND id < ? LIMIT 1`).get(eventId) !== undefined
}

function retiredByTheBus(db: DatabaseSync): Set<number> {
  const rows = db.prepare(`
    SELECT named.value AS decision_id FROM decisions, json_each(coalesce(decisions.supersedes, '[]')) AS named
    UNION SELECT json_extract(payload, '$.decision_id') FROM events WHERE type = '${DECISION_EXPIRED}'
  `).all() as { decision_id: number }[]
  return new Set(rows.map(row => Number(row.decision_id)))
}

function foldDecisionsImported(db: DatabaseSync, event: StoredEvent): void {
  const actor = actorOf(db, event)
  if (actor !== NETWATCH)
    reject(`${DECISIONS_IMPORTED} is ${NETWATCH}'s, not ${actor}'s`)
  if (theBusProjectsTheFileSince(db, event.id))
    return
  const listed = payloadOf(event).decisions
  const imported = Array.isArray(listed) ? listed.map(importedOf) : reject('decisions is not a list')
  if (new Set(imported.map(decision => decision.decisionId)).size !== imported.length)
    reject('a decision_id is listed twice')
  const held = new Map(inForceDecisions(db).map(decision => [decision.decisionId, decision]))
  const kept = new Set(imported.filter(decision => sameDecision(held.get(decision.decisionId), decision)).map(decision => decision.decisionId))
  const retired = retiredByTheBus(db)
  for (const decisionId of held.keys()) {
    if (!kept.has(decisionId))
      archive(db, decisionId)
  }
  for (const decision of imported.filter(entry => !kept.has(entry.decisionId) && !retired.has(entry.decisionId))) {
    db.prepare(`
      INSERT INTO decisions (decision_id, text, scope, source, event_id, until, state) VALUES (?, ?, ?, ?, ?, ?, '${DECISION_IN_FORCE}')
      ON CONFLICT (decision_id) DO UPDATE SET text = excluded.text, scope = excluded.scope, source = excluded.source, event_id = excluded.event_id, until = excluded.until, state = excluded.state
    `).run(decision.decisionId, decision.text, JSON.stringify(decision.cards), OWNER_DECISIONS_FILE, event.id, termOf(decision.text).until)
    answerQuestions(db, decision.cards, event.id)
  }
  archiveSpentDecisions(db)
}

function foldDecisionExpired(db: DatabaseSync, event: StoredEvent): void {
  const actor = actorOf(db, event)
  if (actor !== NETWATCH)
    reject(`${DECISION_EXPIRED} is ${NETWATCH}'s, not ${actor}'s`)
  const decisionId = payloadOf(event).decision_id
  if (!isPositiveInteger(decisionId))
    reject('decision_id is not a positive integer')
  archive(db, decisionId)
}

export function inForceDecisions(db: DatabaseSync): InForceDecision[] {
  return (db.prepare(`SELECT decision_id, text, scope FROM decisions WHERE state = '${DECISION_IN_FORCE}' ORDER BY decision_id`).all() as { decision_id: number, text: string, scope: string | null }[])
    .map(row => ({ decisionId: Number(row.decision_id), text: row.text, cards: JSON.parse(row.scope ?? '[]') as number[] }))
}

export function expireDecisions(db: DatabaseSync, now: Date): void {
  const running = db.prepare(`SELECT decision_id, until FROM decisions WHERE state = '${DECISION_IN_FORCE}' AND until IS NOT NULL`).all() as { decision_id: number, until: string }[]
  for (const row of running.filter(decision => Date.parse(decision.until) <= now.getTime())) {
    const decisionId = Number(row.decision_id)
    appendEvent(db, { ts: now.toISOString(), type: DECISION_EXPIRED, actor: NETWATCH, cardId: null, pr: null, head: null, dedupeKey: `${DECISION_EXPIRED}:${decisionId}:${row.until}`, payload: { decision_id: decisionId, until: row.until }, legacy: false })
  }
}

export function busProjectsDecisions(db: DatabaseSync): boolean {
  return db.prepare(`SELECT 1 FROM events WHERE type = '${DECISIONS_PROJECTED}' LIMIT 1`).get() !== undefined
}

export function startProjectingDecisions(db: DatabaseSync, now: Date): void {
  appendEvent(db, { ts: now.toISOString(), type: DECISIONS_PROJECTED, actor: NETWATCH, cardId: null, pr: null, head: null, dedupeKey: DECISIONS_PROJECTED, payload: {}, legacy: false })
}

export function recordedNumbers(db: DatabaseSync): number[] {
  return (db.prepare('SELECT decision_id FROM decisions').all() as { decision_id: number }[]).map(row => Number(row.decision_id))
}

export function decisionRows(db: DatabaseSync): DecisionRow[] {
  const rows = db.prepare(`
    SELECT decisions.decision_id, decisions.text, decisions.scope, decisions.until, decisions.state, decisions.source, decisions.supersedes, events.ts
    FROM decisions JOIN events ON events.id = decisions.event_id ORDER BY decisions.decision_id
  `).all() as { decision_id: number, text: string, scope: string | null, until: string | null, state: string, source: string, supersedes: string | null, ts: string }[]
  const successor = new Map<number, number>()
  for (const row of rows) {
    for (const target of JSON.parse(row.supersedes ?? '[]') as number[])
      successor.set(target, Number(row.decision_id))
  }
  return rows.map(row => ({
    number: Number(row.decision_id),
    text: row.text,
    cards: JSON.parse(row.scope ?? '[]') as number[],
    until: row.until,
    inForce: row.state === DECISION_IN_FORCE,
    written: row.source === OWNER,
    recordedAt: row.ts,
    supersededBy: successor.get(Number(row.decision_id)) ?? null,
  }))
}

export const DECISION_FOLDS: Record<string, Fold> = {
  [DECISION_RECORDED]: foldDecisionRecorded,
  [DECISIONS_IMPORTED]: foldDecisionsImported,
  [DECISION_EXPIRED]: foldDecisionExpired,
}

import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from './stored.js'
import { appendEvent } from './db.js'
import { CARD_STOPPED, DECISION_RECORDED, OWNER, QUESTION_OWNER } from './inbox.js'
import { NETWATCH } from './observations.js'
import { payloadOf, reject } from './stored.js'

export const STOPPED_CARD = 'stopped'
export const QUEUED_CARD = 'queued'
export const DECISIONS_IMPORTED = 'decisions.imported'
export const OWNER_DECISIONS_FILE = 'owner-decisions.md'

export interface InForceDecision {
  decisionId: number
  text: string
  cards: number[]
}

const STOP_REASONS = new Set(['question.agent', QUESTION_OWNER, 'review', 'conflict', 'fault', 'ci'])

export interface OwnerDecision {
  ts: string
  decisionId: number
  text: string
  cards: number[]
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
    payload: { decision_id: decision.decisionId, text: decision.text, scope: decision.cards, source: OWNER },
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
      db.prepare('UPDATE cards SET state = ?, event_id = ? WHERE card_id = ?').run(QUEUED_CARD, eventId, cardId)
  }
}

function foldCardStopped(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_STOPPED} needs a card_id`)
  const reason = payloadOf(event).reason
  if (typeof reason !== 'string' || !STOP_REASONS.has(reason))
    reject(`reason is not one of ${[...STOP_REASONS].join(' | ')}`)
  db.prepare(`
    INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, '${STOPPED_CARD}', NULL, ?)
    ON CONFLICT (card_id) DO UPDATE SET state = excluded.state, event_id = excluded.event_id
  `).run(cardId, event.id)
}

function scopeOf(payload: Record<string, unknown>): number[] {
  const scope = payload.scope
  return Array.isArray(scope) && scope.every(isPositiveInteger) ? scope : reject('scope is not a list of card numbers')
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
  if (db.prepare('SELECT 1 FROM decisions WHERE decision_id = ?').get(decisionId) !== undefined)
    reject(`D-${decisionId} is already recorded`)
  db.prepare('INSERT INTO decisions (decision_id, text, scope, source, event_id) VALUES (?, ?, ?, ?, ?)')
    .run(decisionId, text, JSON.stringify(cards), OWNER, event.id)
  answerQuestions(db, cards, event.id)
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

function foldDecisionsImported(db: DatabaseSync, event: StoredEvent): void {
  const actor = actorOf(db, event)
  if (actor !== NETWATCH)
    reject(`${DECISIONS_IMPORTED} is ${NETWATCH}'s, not ${actor}'s`)
  const listed = payloadOf(event).decisions
  const imported = Array.isArray(listed) ? listed.map(importedOf) : reject('decisions is not a list')
  if (new Set(imported.map(decision => decision.decisionId)).size !== imported.length)
    reject('a decision_id is listed twice')
  const held = new Map(inForceDecisions(db).map(decision => [decision.decisionId, decision]))
  const kept = new Set(imported.filter(decision => sameDecision(held.get(decision.decisionId), decision)).map(decision => decision.decisionId))
  for (const decisionId of held.keys()) {
    if (!kept.has(decisionId))
      db.prepare('DELETE FROM decisions WHERE decision_id = ?').run(decisionId)
  }
  for (const decision of imported.filter(entry => !kept.has(entry.decisionId))) {
    db.prepare('INSERT INTO decisions (decision_id, text, scope, source, event_id) VALUES (?, ?, ?, ?, ?)')
      .run(decision.decisionId, decision.text, JSON.stringify(decision.cards), OWNER_DECISIONS_FILE, event.id)
    answerQuestions(db, decision.cards, event.id)
  }
}

export function inForceDecisions(db: DatabaseSync): InForceDecision[] {
  return (db.prepare('SELECT decision_id, text, scope FROM decisions ORDER BY decision_id').all() as { decision_id: number, text: string, scope: string | null }[])
    .map(row => ({ decisionId: Number(row.decision_id), text: row.text, cards: JSON.parse(row.scope ?? '[]') as number[] }))
}

export const DECISION_FOLDS: Record<string, Fold> = {
  [CARD_STOPPED]: foldCardStopped,
  [DECISION_RECORDED]: foldDecisionRecorded,
  [DECISIONS_IMPORTED]: foldDecisionsImported,
}

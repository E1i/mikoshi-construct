import type { DatabaseSync } from 'node:sqlite'
import type { Reading } from '../../core/bus-readings.js'
import type { EventPayload } from '../../core/events.js'
import type { Fold, StoredEvent } from '../../core/stored.js'
import type { DecisionRow, DecisionsPort, OwnerWords } from './decisions.js'
import { DECISIONS_FILE } from '../../core/bus-path.js'
import { DECISIONS, readCurrent } from '../../core/bus-readings.js'
import { cardStatesAmong, waitIdsAmong } from '../../core/card-readings.js'
import { appendEvent, DECISION_ARCHIVED, DECISION_IN_FORCE } from '../../core/db.js'
import { DECISION_EXPIRED, DECISION_RECORDED, DECISIONS_IMPORTED, DECISIONS_PROJECTED } from '../../core/events.js'
import { OWNER } from '../../core/inbox.js'
import { NETWATCH } from '../../core/observations.js'
import { payloadOf, reject, Rejection } from '../../core/stored.js'
import { termOf, withoutSource } from './decisions.js'

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

interface RecordedWords {
  decisionId: number
  text: string
  cards: number[]
  supersedes: number[]
}

export interface RecordedDecision extends RecordedWords {
  eventId: number
  recordedAt: string
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

export interface DecisionEventReads {
  actorOf: (db: DatabaseSync, eventId: number) => string | null
  projectedBefore: (db: DatabaseSync, eventId?: number) => boolean
  expiredDecisionIds: (db: DatabaseSync) => unknown[]
  recordedByTheOwner: (db: DatabaseSync) => StoredEvent[]
  tsOf: (db: DatabaseSync, eventIds: readonly number[]) => Map<number, string>
  cardEnded: (state: string | null) => boolean
}

const WAIT_ID_IN_TEXT = /\b[QW]\d+\b/g

export function waitsTheDecisionNames(db: DatabaseSync, text: string): string[] {
  return waitIdsAmong(db, text.match(WAIT_ID_IN_TEXT) ?? [])
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

const CARD_NUMBER_IN_TEXT = /#(\d+)\b/g

function aCardTheTextNamesHasNotEnded(db: DatabaseSync, text: string, reads: DecisionEventReads): boolean {
  const named = [...text.matchAll(CARD_NUMBER_IN_TEXT)].map(match => Number(match[1]))
  return [...cardStatesAmong(db, named).values()].some(state => !reads.cardEnded(state))
}

function everyCardEnded(db: DatabaseSync, cardIds: readonly number[], reads: DecisionEventReads): boolean {
  const states = cardStatesAmong(db, cardIds)
  return cardIds.every(cardId => states.has(cardId) && reads.cardEnded(states.get(cardId) ?? null))
}

const SCOPED_IN_FORCE = `
  SELECT decision_id, text, scope FROM decisions
  WHERE state = '${DECISION_IN_FORCE}' AND json_array_length(coalesce(scope, '[]')) > 0
`

export function archiveSpentDecisions(db: DatabaseSync, reads: DecisionEventReads): void {
  const scoped = db.prepare(SCOPED_IN_FORCE).all() as { decision_id: number, text: string, scope: string }[]
  for (const decision of scoped) {
    if (everyCardEnded(db, JSON.parse(decision.scope) as number[], reads) && !aCardTheTextNamesHasNotEnded(db, decision.text, reads))
      archive(db, Number(decision.decision_id))
  }
}

function recordedWordsOf(payload: Record<string, unknown>): RecordedWords {
  if (payload.source !== OWNER)
    reject(`source is not ${OWNER}`)
  return {
    decisionId: isPositiveInteger(payload.decision_id) ? payload.decision_id : reject('decision_id is not a positive integer'),
    text: typeof payload.text === 'string' && payload.text.trim() !== '' ? payload.text : reject('text is empty'),
    cards: scopeOf(payload),
    supersedes: payload.supersedes === undefined ? [] : numbersOf(payload, 'supersedes'),
  }
}

function foldDecisionRecorded(db: DatabaseSync, event: StoredEvent, reads: DecisionEventReads): void {
  const actor = reads.actorOf(db, event.id)
  if (actor !== OWNER)
    reject(`${DECISION_RECORDED} is the owner's, not ${actor}'s`)
  const { decisionId, text, cards, supersedes } = recordedWordsOf(payloadOf(event))
  if (db.prepare('SELECT 1 FROM decisions WHERE decision_id = ?').get(decisionId) !== undefined)
    reject(`D-${decisionId} is already recorded`)
  db.prepare('INSERT INTO decisions (decision_id, text, scope, source, event_id, until, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(decisionId, text, JSON.stringify(cards), OWNER, event.id, termOf(text).until, JSON.stringify(supersedes))
  for (const target of supersedes)
    archive(db, target)
  archiveSpentDecisions(db, reads)
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

const SUPERSEDED = `SELECT named.value AS decision_id FROM decisions, json_each(coalesce(decisions.supersedes, '[]')) AS named`

function retiredByTheBus(db: DatabaseSync, reads: DecisionEventReads): Set<number> {
  const superseded = (db.prepare(SUPERSEDED).all() as { decision_id: number }[]).map(row => row.decision_id)
  const expired = reads.expiredDecisionIds(db)
  return new Set([...superseded, ...expired].map(Number))
}

function foldDecisionsImported(db: DatabaseSync, event: StoredEvent, reads: DecisionEventReads): void {
  const actor = reads.actorOf(db, event.id)
  if (actor !== NETWATCH)
    reject(`${DECISIONS_IMPORTED} is ${NETWATCH}'s, not ${actor}'s`)
  if (reads.projectedBefore(db, event.id))
    return
  const listed = payloadOf(event).decisions
  const imported = Array.isArray(listed) ? listed.map(importedOf) : reject('decisions is not a list')
  if (new Set(imported.map(decision => decision.decisionId)).size !== imported.length)
    reject('a decision_id is listed twice')
  const held = new Map(inForceDecisions(db).map(decision => [decision.decisionId, decision]))
  const kept = new Set(imported.filter(decision => sameDecision(held.get(decision.decisionId), decision)).map(decision => decision.decisionId))
  const retired = retiredByTheBus(db, reads)
  for (const decisionId of held.keys()) {
    if (!kept.has(decisionId))
      archive(db, decisionId)
  }
  for (const decision of imported.filter(entry => !kept.has(entry.decisionId) && !retired.has(entry.decisionId))) {
    db.prepare(`
      INSERT INTO decisions (decision_id, text, scope, source, event_id, until, state) VALUES (?, ?, ?, ?, ?, ?, '${DECISION_IN_FORCE}')
      ON CONFLICT (decision_id) DO UPDATE SET text = excluded.text, scope = excluded.scope, source = excluded.source, event_id = excluded.event_id, until = excluded.until, state = excluded.state
    `).run(decision.decisionId, decision.text, JSON.stringify(decision.cards), DECISIONS_FILE, event.id, termOf(decision.text).until)
  }
  archiveSpentDecisions(db, reads)
}

function foldDecisionExpired(db: DatabaseSync, event: StoredEvent, reads: DecisionEventReads): void {
  const actor = reads.actorOf(db, event.id)
  if (actor !== NETWATCH)
    reject(`${DECISION_EXPIRED} is ${NETWATCH}'s, not ${actor}'s`)
  const decisionId = payloadOf(event).decision_id
  if (!isPositiveInteger(decisionId))
    reject('decision_id is not a positive integer')
  archive(db, decisionId)
}

export function inForceDecisions(db: DatabaseSync): InForceDecision[] {
  return inForceRows(db).map(({ decisionId, text, cards }) => ({ decisionId, text, cards }))
}

export function currentDecisions(db: DatabaseSync): Reading<InForceDecision[]> {
  return readCurrent(db, [DECISIONS], () => inForceDecisions(db))
}

export function expireDecisions(db: DatabaseSync, now: Date): void {
  const inForce = db.prepare(`SELECT decision_id, text, until FROM decisions WHERE state = '${DECISION_IN_FORCE}'`).all() as { decision_id: number, text: string, until: string | null }[]
  for (const row of inForce) {
    const until = row.until ?? termOf(row.text).until
    if (until !== null && Date.parse(until) <= now.getTime()) {
      const decisionId = Number(row.decision_id)
      appendEvent(db, { ts: now.toISOString(), type: DECISION_EXPIRED, actor: NETWATCH, cardId: null, pr: null, head: null, dedupeKey: `${DECISION_EXPIRED}:${decisionId}:${until}`, payload: { decision_id: decisionId, until } satisfies EventPayload<typeof DECISION_EXPIRED>, legacy: false })
    }
  }
}

export function busProjectsDecisions(db: DatabaseSync, reads: DecisionEventReads): boolean {
  return reads.projectedBefore(db)
}

export function startProjectingDecisions(db: DatabaseSync, now: Date): void {
  appendEvent(db, { ts: now.toISOString(), type: DECISIONS_PROJECTED, actor: NETWATCH, cardId: null, pr: null, head: null, dedupeKey: DECISIONS_PROJECTED, payload: {}, legacy: false })
}

function recordedDecisionOf(event: StoredEvent): RecordedDecision[] {
  try {
    return [{ ...recordedWordsOf(payloadOf(event)), eventId: event.id, recordedAt: event.ts }]
  }
  catch (error) {
    if (error instanceof Rejection)
      return []
    throw error
  }
}

function firstEventOfEachDecision(decisions: RecordedDecision[]): RecordedDecision[] {
  const given = new Set<number>()
  return decisions.filter((decision) => {
    if (given.has(decision.decisionId))
      return false
    given.add(decision.decisionId)
    return true
  })
}

export function decisionHistory(db: DatabaseSync, reads: DecisionEventReads): RecordedDecision[] {
  return firstEventOfEachDecision(reads.recordedByTheOwner(db).flatMap(recordedDecisionOf))
}

export function recordedNumbers(db: DatabaseSync, reads: DecisionEventReads): number[] {
  const inTheTable = (db.prepare('SELECT decision_id FROM decisions').all() as { decision_id: number }[]).map(row => Number(row.decision_id))
  return [...new Set([...inTheTable, ...decisionHistory(db, reads).map(decision => decision.decisionId)])]
}

const DECISION_ROWS = 'SELECT decision_id, text, scope, until, state, source, supersedes, event_id FROM decisions ORDER BY decision_id'

interface DecisionTableRow {
  decision_id: number
  text: string
  scope: string | null
  until: string | null
  state: string
  source: string
  supersedes: string | null
  event_id: number
  ts: string
}

export function decisionRecordedAfter(db: DatabaseSync, decisionId: number, eventId: number): boolean {
  return db.prepare('SELECT 1 FROM decisions WHERE decision_id = ? AND event_id > ?').get(decisionId, eventId) !== undefined
}

export function decisionRows(db: DatabaseSync, reads: DecisionEventReads): DecisionRow[] {
  const ownDate = new Map(decisionHistory(db, reads).map(decision => [decision.decisionId, decision.recordedAt]))
  const stored = db.prepare(DECISION_ROWS).all() as Omit<DecisionTableRow, 'ts'>[]
  const tsOf = reads.tsOf(db, stored.map(row => Number(row.event_id)))
  const rows = stored.flatMap((row) => {
    const ts = tsOf.get(Number(row.event_id))
    return ts === undefined ? [] : [{ ...row, ts }]
  })
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
    recordedAt: ownDate.get(Number(row.decision_id)) ?? row.ts,
    supersededBy: successor.get(Number(row.decision_id)) ?? null,
  }))
}

export function decisionFolds(reads: DecisionEventReads): Record<string, Fold> {
  return {
    [DECISION_RECORDED]: (db, event) => foldDecisionRecorded(db, event, reads),
    [DECISIONS_IMPORTED]: (db, event) => foldDecisionsImported(db, event, reads),
    [DECISION_EXPIRED]: (db, event) => foldDecisionExpired(db, event, reads),
  }
}

interface InForceRow {
  decisionId: number
  text: string
  cards: number[]
  source: string | undefined
}

function inForceRows(db: DatabaseSync): InForceRow[] {
  return (db.prepare('SELECT * FROM decisions WHERE state = ? ORDER BY decision_id').all(DECISION_IN_FORCE) as { decision_id: number, text: string, scope: string | null, source?: string }[])
    .map(row => ({ decisionId: Number(row.decision_id), text: row.text, cards: JSON.parse(row.scope ?? '[]') as number[], source: row.source }))
}

export class BusDecisions implements DecisionsPort {
  constructor(private readonly db: DatabaseSync) {}

  inForce(): readonly OwnerWords[] {
    return inForceRows(this.db).map(row => ({ decisionId: row.decisionId, words: withoutSource(row.text), cards: row.cards, written: row.source === OWNER }))
  }
}

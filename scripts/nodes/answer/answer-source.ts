import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../core/lease.js'
import type { InForceDecision } from '../../policy/decisions/index.js'
import { CARD_BODIES, cardSessionsIn } from '../../core/card-bodies.js'
import { decisionOfKey } from '../../core/card-decisions.js'
import { cardHoldOf } from '../../core/card-hold.js'
import { CARD_STARTED, CARD_STOPPED, QUESTION_AGENT, QUESTION_OWNER, REVIEW_RECORDED } from '../../core/events.js'
import { latestTurnOf } from '../../core/queue.js'
import { cardDecisionLines, decisionsInForceAt } from '../../policy/shards.js'

export { cardDecisionLines as boundDecisionLines } from '../../policy/shards.js'

export const LATEST_EVENTS = 20

export interface CardEvent {
  id: number
  ts: string
  type: string
  payload: unknown
}

export interface WideningRequest {
  paths: string[]
}

export type AnswerSource
  = | { kind: 'question', detail: string, widen: WideningRequest | null, events: CardEvent[], decisions: string[] }
    | { kind: 'changes', findings: string[], failedChecks?: string[], events: CardEvent[], decisions: string[] }
    | { kind: 'ci', failedChecks: string[], events: CardEvent[], decisions: string[] }
    | { kind: 'decision', decisionId: number, text: string, events: CardEvent[], decisions: string[] }

export interface CardSession {
  session: string
  worktree: string
  branch: string
}

interface Row {
  id: number
  ts: string
  type: string
  payload: string
}

function parsed(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string' && each !== '') : []
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function latestEvents(db: DatabaseSync, cardId: number): CardEvent[] {
  const rows = db.prepare(`SELECT id, ts, type, payload FROM events WHERE card_id = ? AND legacy = 0 ORDER BY id DESC LIMIT ${LATEST_EVENTS}`).all(cardId) as unknown as Row[]
  return rows.reverse().map(row => ({ id: Number(row.id), ts: row.ts, type: row.type, payload: parsed(row.payload) }))
}

function standingStop(db: DatabaseSync, cardId: number): { id: number, payload: Record<string, unknown> } | null {
  const row = db.prepare(`SELECT id, payload FROM events WHERE id = ${latestTurnOf('?')} AND type = '${CARD_STOPPED}'`).get(cardId) as { id: number, payload: string } | undefined
  return row === undefined ? null : { id: Number(row.id), payload: parsed(row.payload) }
}

function openQuestion(db: DatabaseSync, cardId: number): Record<string, unknown> | null {
  const payload = standingStop(db, cardId)?.payload ?? null
  return payload?.reason === QUESTION_AGENT ? payload : null
}

function decisionsBoundTo(db: DatabaseSync, cardId: number, now: Date): InForceDecision[] {
  return decisionsInForceAt(db, now).filter(decision => decision.cards.includes(cardId))
}

const QUESTION_REASONS: readonly unknown[] = [QUESTION_AGENT, QUESTION_OWNER]

function recordedAfter(db: DatabaseSync, decision: InForceDecision, eventId: number): boolean {
  return db.prepare('SELECT 1 FROM decisions WHERE decision_id = ? AND event_id > ?').get(decision.decisionId, eventId) !== undefined
}

export function decisionAnsweringRepeat(db: DatabaseSync, cardId: number, question: string, now: Date): number | null {
  const stop = standingStop(db, cardId)
  if (stop === null || !QUESTION_REASONS.includes(stop.payload.reason) || text(stop.payload.detail)?.trim() !== question.trim())
    return null
  return decisionsBoundTo(db, cardId, now).find(decision => recordedAfter(db, decision, stop.id))?.decisionId ?? null
}

function widenOf(payload: Record<string, unknown>): WideningRequest | null {
  const paths = strings(payload.widen)
  return paths.length === 0 ? null : { paths }
}

function changesOn(db: DatabaseSync, lease: Lease): string[] | null {
  if (lease.pr === null || lease.head === null)
    return null
  const verdict = db.prepare('SELECT verdict_on_head FROM prs WHERE pr = ? AND head = ?').get(lease.pr, lease.head) as { verdict_on_head: string | null } | undefined
  if (verdict?.verdict_on_head !== 'changes')
    return null
  const review = db.prepare(`SELECT payload FROM events WHERE type = '${REVIEW_RECORDED}' AND card_id = ? AND head = ? AND json_extract(payload, '$.verdict') = 'changes' ORDER BY id DESC LIMIT 1`).get(lease.cardId, lease.head) as { payload: string } | undefined
  return review === undefined ? [] : strings(parsed(review.payload).findings)
}

export function failedChecksOn(db: DatabaseSync, lease: Lease): string[] | null {
  if (lease.pr === null || lease.head === null)
    return null
  const red = db.prepare(`SELECT 1 FROM prs WHERE pr = ? AND head = ? AND ci = 'red'`).get(lease.pr, lease.head)
  if (red === undefined)
    return null
  const observed = db.prepare(`SELECT payload FROM events WHERE type = 'pr.observed' AND pr = ? AND head = ? AND json_extract(payload, '$.ci') = 'red' ORDER BY id DESC LIMIT 1`).get(lease.pr, lease.head) as { payload: string } | undefined
  return observed === undefined ? [] : strings(parsed(observed.payload).failed_checks)
}

export function answerSourceOf(db: DatabaseSync, lease: Lease, now: Date = new Date()): AnswerSource | null {
  const events = latestEvents(db, lease.cardId)
  const decisions = cardDecisionLines(db, lease.cardId, now)
  const decided = decisionOfKey(lease.taskKey)
  const decision = decided === undefined ? undefined : decisionsInForceAt(db, now).find(each => each.decisionId === decided)
  if (decision !== undefined)
    return { kind: 'decision', decisionId: decision.decisionId, text: decision.text, events, decisions }
  const question = openQuestion(db, lease.cardId)
  if (question !== null)
    return { kind: 'question', detail: text(question.detail) ?? '', widen: widenOf(question), events, decisions }
  const findings = changesOn(db, lease)
  const failedChecks = failedChecksOn(db, lease)
  if (findings !== null)
    return { kind: 'changes', findings, ...(failedChecks === null ? {} : { failedChecks }), events, decisions }
  return failedChecks === null ? null : { kind: 'ci', failedChecks, events, decisions }
}

export interface AdmittedScope {
  admission: number
  touches: string[]
  creates: string[]
}

function listOf(column: string | null): string[] {
  return column === null ? [] : strings(JSON.parse(column))
}

export function admittedScopeOf(db: DatabaseSync, cardId: number): AdmittedScope | null {
  const row = db.prepare(`SELECT admission_event_id, touches, creates FROM ${CARD_BODIES} WHERE card_id = ?`).get(cardId) as { admission_event_id: number, touches: string | null, creates: string | null } | undefined
  return row === undefined ? null : { admission: Number(row.admission_event_id), touches: listOf(row.touches), creates: listOf(row.creates) }
}

export const NO_RECORDED_SESSION = ''
export const START_LINE = 'path'

function startedOf(db: DatabaseSync, cardId: number): CardSession | null {
  const row = db.prepare(`SELECT payload FROM events WHERE card_id = ? AND type = '${CARD_STARTED}' AND legacy = 0 ORDER BY id DESC LIMIT 1`).get(cardId) as { payload: string } | undefined
  if (row === undefined)
    return null
  const payload = parsed(row.payload)
  const started = text(payload.session)
  const worktree = text(payload.worktree)
  const branch = text(payload.branch)
  if (started === null || worktree === null || branch === null)
    return null
  return { session: cardSessionsIn(db, cardId).at(-1) ?? started, worktree, branch }
}

function chainSessionOf(payload: Record<string, unknown>): string {
  const windowSession = text(payload.shift) === null
  return windowSession ? NO_RECORDED_SESSION : text(payload.session) ?? NO_RECORDED_SESSION
}

function startLineOf(db: DatabaseSync, cardId: number): CardSession | null {
  const row = db.prepare(`SELECT payload FROM events WHERE card_id = ? AND type = '${START_LINE}' AND legacy = 1 AND json_type(payload, '$.worktree') = 'text' AND json_type(payload, '$.branch') = 'text' ORDER BY id DESC LIMIT 1`).get(cardId) as { payload: string } | undefined
  if (row === undefined)
    return null
  const payload = parsed(row.payload)
  const worktree = text(payload.worktree)
  const branch = text(payload.branch)
  return worktree === null || branch === null ? null : { session: chainSessionOf(payload), worktree, branch }
}

export function cardSessionOf(db: DatabaseSync, cardId: number): CardSession | null {
  return startedOf(db, cardId) ?? startLineOf(db, cardId)
}

const DRAFT_PR = `SELECT pr FROM prs WHERE card_id = ? AND state = 'open' AND draft = 1 ORDER BY pr DESC LIMIT 1`

export function ownerHoldOf(db: DatabaseSync, cardId: number): string | null {
  const hold = cardHoldOf(db, cardId)
  if (hold !== null)
    return hold
  const draft = db.prepare(DRAFT_PR).get(cardId) as { pr: number } | undefined
  return draft === undefined ? null : `card #${cardId} has the draft pull request #${Number(draft.pr)}, which is the owner's until it is marked ready`
}

export function openPrOfCard(db: DatabaseSync, cardId: number): number | null {
  const row = db.prepare(`SELECT pr FROM prs WHERE card_id = ? AND state = 'open' ORDER BY pr DESC LIMIT 1`).get(cardId) as { pr: number } | undefined
  return row === undefined ? null : Number(row.pr)
}

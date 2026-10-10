import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from './lease.js'
import { CARD_STARTED, CARD_STOPPED } from './inbox.js'
import { latestTurnOf, QUESTION_AGENT } from './queue.js'
import { REVIEW_RECORDED } from './review-worker.js'

export const LATEST_EVENTS = 20

export interface CardEvent {
  id: number
  ts: string
  type: string
  payload: unknown
}

export interface WideningRequest {
  paths: string[]
  touches: string[]
}

export type AnswerSource
  = | { kind: 'question', detail: string, widen: WideningRequest | null, events: CardEvent[] }
    | { kind: 'changes', findings: string[], events: CardEvent[] }

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

function openQuestion(db: DatabaseSync, cardId: number): Record<string, unknown> | null {
  const row = db.prepare(`SELECT payload FROM events WHERE id = ${latestTurnOf('?')} AND type = '${CARD_STOPPED}'`).get(cardId) as { payload: string } | undefined
  if (row === undefined)
    return null
  const payload = parsed(row.payload)
  return payload.reason === QUESTION_AGENT ? payload : null
}

function widenOf(payload: Record<string, unknown>): WideningRequest | null {
  const paths = strings(payload.widen)
  return paths.length === 0 ? null : { paths, touches: strings(payload.touches) }
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

export function answerSourceOf(db: DatabaseSync, lease: Lease): AnswerSource | null {
  const events = latestEvents(db, lease.cardId)
  const question = openQuestion(db, lease.cardId)
  if (question !== null)
    return { kind: 'question', detail: text(question.detail) ?? '', widen: widenOf(question), events }
  const findings = changesOn(db, lease)
  return findings === null ? null : { kind: 'changes', findings, events }
}

export function cardSessionOf(db: DatabaseSync, cardId: number): CardSession | null {
  const row = db.prepare(`SELECT payload FROM events WHERE card_id = ? AND type = '${CARD_STARTED}' AND legacy = 0 ORDER BY id DESC LIMIT 1`).get(cardId) as { payload: string } | undefined
  if (row === undefined)
    return null
  const payload = parsed(row.payload)
  const session = text(payload.session)
  const worktree = text(payload.worktree)
  const branch = text(payload.branch)
  return session === null || worktree === null || branch === null ? null : { session, worktree, branch }
}

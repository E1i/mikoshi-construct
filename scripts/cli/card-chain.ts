import type { DatabaseSync } from 'node:sqlite'
import { CARD_BODIES } from '../core/card-bodies.js'
import { CARD_VERIFIED, REVIEW_RECORDED } from '../core/events.js'

const DECISION = /\bD-[1-9]\d*\b/g

const ADMISSION = `SELECT json_extract(payload, '$.prevAdmissionId') AS previous FROM events WHERE id = ?`
const LATEST_OF_TYPE = `SELECT id, payload FROM events WHERE legacy = 0 AND type = ? AND card_id = ? ORDER BY id DESC LIMIT 1`

export interface CardChain {
  card: number
  versions: number[]
  decisions: string[]
  verdict: { event: number, verdict: unknown } | null
  proof: number | null
}

function versionsFrom(db: DatabaseSync, latest: number): number[] {
  const versions: number[] = []
  let current: number | null = latest
  while (current !== null && !versions.includes(current)) {
    versions.push(current)
    const row = db.prepare(ADMISSION).get(current) as { previous: unknown } | undefined
    current = typeof row?.previous === 'number' ? row.previous : null
  }
  return versions
}

function latestOf(db: DatabaseSync, type: string, card: number): { id: number, payload: string } | undefined {
  return db.prepare(LATEST_OF_TYPE).get(type, card) as { id: number, payload: string } | undefined
}

export function cardChain(db: DatabaseSync, card: number): CardChain | null {
  const body = db.prepare(`SELECT admission_event_id, text FROM ${CARD_BODIES} WHERE card_id = ?`).get(card) as { admission_event_id: number, text: string } | undefined
  if (body === undefined)
    return null
  const review = latestOf(db, REVIEW_RECORDED, card)
  return {
    card,
    versions: versionsFrom(db, body.admission_event_id),
    decisions: [...new Set(body.text.match(DECISION) ?? [])],
    verdict: review === undefined ? null : { event: review.id, verdict: (JSON.parse(review.payload) as Record<string, unknown>).verdict },
    proof: latestOf(db, CARD_VERIFIED, card)?.id ?? null,
  }
}

import type { DatabaseSync } from 'node:sqlite'
import { prOf } from './identifiers.js'

export const CARD_STARTED = 'card.started'
export const CARD_ADMITTED = 'card.admitted'
export const CARD_CLOSED = 'card.closed'

const CARD_LIFE = `
  SELECT id, type, card_id, payload FROM events
  WHERE legacy = 0 AND card_id IS NOT NULL AND type IN ('${CARD_ADMITTED}', '${CARD_STARTED}', '${CARD_CLOSED}')
  ORDER BY id
`

const MERGED_CARDS = `SELECT DISTINCT card_id FROM prs WHERE state = 'merged' AND card_id IS NOT NULL`

const OPEN_LAUNCHES = `SELECT card_id FROM tasks WHERE queue = 'launch' AND state IN ('queued', 'leased')`

interface LifeRow {
  id: number
  type: string
  card_id: number
  payload: string
}

interface CardLife {
  cardId: number
  lane: string | null
  depends: number[]
  started: boolean
  closed: boolean
}

function payloadOf(row: LifeRow): Record<string, unknown> {
  try {
    const payload = JSON.parse(row.payload) as unknown
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function laneOf(payload: Record<string, unknown>): string | null {
  const lane = payload.lane ?? payload.axis
  return typeof lane === 'string' && lane !== '' ? lane : null
}

function dependsOf(payload: Record<string, unknown>): number[] {
  return Array.isArray(payload.depends) ? payload.depends.map(prOf).filter(each => each !== null) : []
}

function cardLives(db: DatabaseSync): Map<number, CardLife> {
  const lives = new Map<number, CardLife>()
  for (const row of db.prepare(CARD_LIFE).all() as unknown as LifeRow[]) {
    if (row.type === CARD_ADMITTED) {
      const payload = payloadOf(row)
      lives.set(row.card_id, { cardId: row.card_id, lane: laneOf(payload), depends: dependsOf(payload), started: false, closed: false })
      continue
    }
    const life = lives.get(row.card_id)
    if (life !== undefined && row.type === CARD_STARTED)
      life.started = true
    if (life !== undefined && row.type === CARD_CLOSED)
      life.closed = true
  }
  return lives
}

function isQueued(life: CardLife | undefined): boolean {
  return life !== undefined && !life.started && !life.closed
}

export function queuedLane(db: DatabaseSync, cardId: number): string | null {
  const life = cardLives(db).get(cardId)
  return isQueued(life) ? life!.lane : null
}

export function launchCandidates(db: DatabaseSync): number[] {
  const lives = cardLives(db)
  const merged = new Set((db.prepare(MERGED_CARDS).all() as { card_id: number }[]).map(row => row.card_id))
  const launching = new Set((db.prepare(OPEN_LAUNCHES).all() as { card_id: number }[]).map(row => row.card_id))
  const busy = new Set<string>()
  for (const life of lives.values()) {
    const running = life.started && !life.closed && !merged.has(life.cardId)
    if (life.lane !== null && (running || launching.has(life.cardId)))
      busy.add(life.lane)
  }
  const chosen: number[] = []
  for (const life of [...lives.values()].sort((a, b) => a.cardId - b.cardId)) {
    if (!isQueued(life) || life.lane === null || busy.has(life.lane) || !life.depends.every(card => merged.has(card)))
      continue
    busy.add(life.lane)
    chosen.push(life.cardId)
  }
  return chosen
}

import type { DatabaseSync } from 'node:sqlite'
import { prOf } from './identifiers.js'
import { CARD_STARTED, CARD_STOPPED } from './inbox.js'

export const CARD_ADMITTED = 'card.admitted'
export const CARD_CLOSED = 'card.closed'

const CARD_LIFE = `
  SELECT id, type, card_id, dedupe_key, payload FROM events
  WHERE legacy = 0 AND card_id IS NOT NULL AND type IN ('${CARD_ADMITTED}', '${CARD_STARTED}', '${CARD_CLOSED}', '${CARD_STOPPED}')
  ORDER BY id
`

const MERGED_CARDS = `SELECT DISTINCT card_id FROM prs WHERE state = 'merged' AND card_id IS NOT NULL`

const LEGACY_MERGED_CARDS = `SELECT DISTINCT card_id FROM events WHERE legacy = 1 AND card_id IS NOT NULL AND type = 'merge'`

const LEGACY_LATEST_START_OR_CLOSE = `SELECT card_id, MAX(id) AS id FROM events WHERE legacy = 1 AND card_id IS NOT NULL AND type = 'path' GROUP BY card_id`

const ADMISSION_SOURCE = `SELECT id FROM events WHERE legacy = 1 AND dedupe_key = ?`

const OPEN_LAUNCHES = `SELECT card_id FROM tasks WHERE queue = 'launch' AND state IN ('queued', 'leased')`

interface LifeRow {
  id: number
  type: string
  card_id: number
  dedupe_key: string
  payload: string
}

export interface LaunchCandidate {
  cardId: number
  generation: string
}

interface CardLife {
  cardId: number
  generation: string
  admittedAt: number
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

function generationOf(row: LifeRow, payload: Record<string, unknown>): string {
  return typeof payload.admission === 'string' && payload.admission !== '' ? payload.admission : row.dedupe_key
}

function dependsOf(payload: Record<string, unknown>): number[] {
  return Array.isArray(payload.depends) ? payload.depends.map(prOf).filter(each => each !== null) : []
}

function admittedAtOf(db: DatabaseSync, row: LifeRow, payload: Record<string, unknown>): number {
  if (typeof payload.admission !== 'string')
    return row.id
  const source = db.prepare(ADMISSION_SOURCE).get(payload.admission) as { id: number } | undefined
  return source?.id ?? row.id
}

function cardLives(db: DatabaseSync): Map<number, CardLife> {
  const lives = new Map<number, CardLife>()
  for (const row of db.prepare(CARD_LIFE).all() as unknown as LifeRow[]) {
    const life = lives.get(row.card_id)
    if (row.type === CARD_ADMITTED) {
      const payload = payloadOf(row)
      const running = life !== undefined && life.started && !life.closed
      lives.set(row.card_id, { cardId: row.card_id, generation: generationOf(row, payload), admittedAt: admittedAtOf(db, row, payload), lane: laneOf(payload), depends: dependsOf(payload), started: running, closed: false })
      continue
    }
    if (life !== undefined && row.type === CARD_STARTED)
      life.started = true
    if (life !== undefined && (row.type === CARD_CLOSED || row.type === CARD_STOPPED))
      life.closed = true
  }
  return lives
}

function cardSet(db: DatabaseSync, query: string): Set<number> {
  return new Set((db.prepare(query).all() as { card_id: number }[]).map(row => row.card_id))
}

interface Settled {
  merged: Set<number>
  latestStartOrClose: Map<number, number>
}

function settledCards(db: DatabaseSync, merged: Set<number>): Settled {
  const latestStartOrClose = new Map((db.prepare(LEGACY_LATEST_START_OR_CLOSE).all() as { card_id: number, id: number }[]).map(row => [row.card_id, row.id]))
  return { merged: new Set([...merged, ...cardSet(db, LEGACY_MERGED_CARDS)]), latestStartOrClose }
}

function startedOrClosedSinceAdmission(life: CardLife, settled: Settled): boolean {
  return (settled.latestStartOrClose.get(life.cardId) ?? 0) > life.admittedAt
}

function isQueued(life: CardLife | undefined, settled: Settled): boolean {
  return life !== undefined && !life.started && !life.closed && !settled.merged.has(life.cardId) && !startedOrClosedSinceAdmission(life, settled)
}

export function queuedLane(db: DatabaseSync, cardId: number): string | null {
  const life = cardLives(db).get(cardId)
  return isQueued(life, settledCards(db, cardSet(db, MERGED_CARDS))) ? life!.lane : null
}

export function launchCandidates(db: DatabaseSync): LaunchCandidate[] {
  const lives = cardLives(db)
  const merged = cardSet(db, MERGED_CARDS)
  const settled = settledCards(db, merged)
  const launching = cardSet(db, OPEN_LAUNCHES)
  const busy = new Set<string>()
  for (const life of lives.values()) {
    const running = life.started && !life.closed && !merged.has(life.cardId)
    if (life.lane !== null && (running || launching.has(life.cardId)))
      busy.add(life.lane)
  }
  const chosen: LaunchCandidate[] = []
  for (const life of [...lives.values()].sort((a, b) => a.cardId - b.cardId)) {
    if (!isQueued(life, settled) || life.lane === null || busy.has(life.lane) || !life.depends.every(card => merged.has(card)))
      continue
    busy.add(life.lane)
    chosen.push({ cardId: life.cardId, generation: life.generation })
  }
  return chosen
}

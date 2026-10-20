import type { DatabaseSync } from 'node:sqlite'
import type { ShiftTask } from '../../src/card/task-file.js'
import { existsSync } from 'node:fs'
import { parseParkingFile } from '../../src/card/parking.js'
import { taskConflicts } from '../shift/overlap.js'
import { NOT_A_BACKFILL } from './backfill-source.js'
import { prOf } from './identifiers.js'
import { CARD_STARTED, CARD_STOPPED } from './inbox.js'
import { namesQueueLive } from './live-decision.js'

export const CARD_ADMITTED = 'card.admitted'
export const CARD_CLOSED = 'card.closed'
export const FALLS_BEFORE_CUT = 2

export type Contour = 'cheap' | 'ladder'

const CARD_FELL_EVENT = 'card.fell'
const GHOST_ROW_EVENT = 'ghost.row'
const FREE_ROW = 'free'

const CARD_LIFE = `
  SELECT id, type, card_id, dedupe_key, payload FROM events
  WHERE legacy = 0 AND card_id IS NOT NULL AND type IN ('${CARD_ADMITTED}', '${CARD_STARTED}', '${CARD_CLOSED}', '${CARD_STOPPED}', '${GHOST_ROW_EVENT}')
    AND ${NOT_A_BACKFILL}
  ORDER BY id
`

const FALLS = `
  SELECT card_id, count(*) AS falls FROM events
  WHERE card_id IS NOT NULL AND ((legacy = 0 AND type = '${CARD_FELL_EVENT}') OR (legacy = 1 AND type = 'fall'))
  GROUP BY card_id
`

const MERGED_CARDS = `SELECT DISTINCT card_id FROM prs WHERE state = 'merged' AND card_id IS NOT NULL`

const LEGACY_MERGED_CARDS = `SELECT DISTINCT card_id FROM events WHERE legacy = 1 AND card_id IS NOT NULL AND type = 'merge'`

const LEGACY_LATEST_START_OR_CLOSE = `SELECT card_id, MAX(id) AS id FROM events WHERE legacy = 1 AND card_id IS NOT NULL AND type = 'path' GROUP BY card_id`

const ADMISSION_SOURCE = `SELECT id FROM events WHERE legacy = 1 AND dedupe_key = ?`

const LIVE_DECISIONS = `SELECT text, event_id FROM decisions`

const OPEN_LAUNCHES = `SELECT card_id FROM tasks WHERE queue = 'launch' AND state IN ('queued', 'leased')`

const OPEN_PR_CARDS = `SELECT DISTINCT card_id FROM prs WHERE state = 'open' AND card_id IS NOT NULL`

const ENDED_CARDS = `SELECT card_id FROM cards WHERE state IN ('dropped', 'closed', 'merged', 'stopped')`

const STARTED_TREES = `
  SELECT DISTINCT card_id, json_extract(payload, '$.worktree') AS worktree FROM events
  WHERE legacy = 0 AND type = '${CARD_STARTED}' AND card_id IS NOT NULL AND json_valid(payload) AND json_type(payload, '$.worktree') = 'text'
`

export type TreeReader = (worktree: string) => boolean

interface LifeRow {
  id: number
  type: string
  card_id: number
  dedupe_key: string
  payload: string
}

export interface LaunchableCard {
  lane: string
  contour: Contour
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
  task: ShiftTask | null
  depends: number[]
  contour: Contour
  started: boolean
  startedAt: number | null
  freeRow: number | null
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

function taskOf(row: LifeRow, payload: Record<string, unknown>): ShiftTask | null {
  if (typeof payload.text !== 'string')
    return null
  const parsed = parseParkingFile(`${row.card_id}.md`, payload.text)
  return parsed.kind === 'parked' ? parsed.parked.task : null
}

function overlapsAny(task: ShiftTask | null, taken: readonly ShiftTask[]): boolean {
  return task !== null && taken.some(other => taskConflicts([other, task]).length > 0)
}

function generationOf(row: LifeRow, payload: Record<string, unknown>): string {
  return typeof payload.admission === 'string' && payload.admission !== '' ? payload.admission : row.dedupe_key
}

function contourOf(payload: Record<string, unknown>): Contour {
  return payload.contour === 'ladder' ? 'ladder' : 'cheap'
}

function dependsOf(payload: Record<string, unknown>): number[] {
  return Array.isArray(payload.depends) ? payload.depends.map(prOf).filter(each => each !== null) : []
}

function admittedAtOf(db: DatabaseSync, row: LifeRow, payload: Record<string, unknown>): { at: number, legacyLine: boolean } {
  if (typeof payload.admission !== 'string')
    return { at: row.id, legacyLine: false }
  const source = db.prepare(ADMISSION_SOURCE).get(payload.admission) as { id: number } | undefined
  return { at: source?.id ?? row.id, legacyLine: source !== undefined }
}

function liveCutoff(db: DatabaseSync): number | null {
  const cutoffs = (db.prepare(LIVE_DECISIONS).all() as { text: string, event_id: number }[])
    .filter(decision => namesQueueLive(decision.text, 'launch'))
    .map(decision => Number(decision.event_id))
  return cutoffs.length === 0 ? null : Math.min(...cutoffs)
}

function cardLives(db: DatabaseSync): Map<number, CardLife> {
  const lives = new Map<number, CardLife>()
  const cutoff = liveCutoff(db)
  for (const row of db.prepare(CARD_LIFE).all() as unknown as LifeRow[]) {
    const life = lives.get(row.card_id)
    if (row.type === CARD_ADMITTED) {
      const payload = payloadOf(row)
      const running = life !== undefined && life.started && !life.closed
      const admitted = admittedAtOf(db, row, payload)
      const beforeLive = admitted.legacyLine && cutoff !== null && admitted.at < cutoff
      lives.set(row.card_id, { cardId: row.card_id, generation: generationOf(row, payload), admittedAt: admitted.at, lane: laneOf(payload), task: taskOf(row, payload), depends: dependsOf(payload), contour: contourOf(payload), started: running, startedAt: null, freeRow: null, closed: beforeLive })
      continue
    }
    if (life !== undefined && row.type === CARD_STARTED) {
      life.started = true
      life.startedAt = row.id
      life.freeRow = null
    }
    if (life !== undefined && row.type === GHOST_ROW_EVENT && life.startedAt !== null && life.freeRow === null && payloadOf(row).state === FREE_ROW)
      life.freeRow = row.id
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

function fallCounts(db: DatabaseSync): Map<number, number> {
  return new Map((db.prepare(FALLS).all() as { card_id: number, falls: number }[]).map(row => [row.card_id, Number(row.falls)]))
}

function reviewDue(life: CardLife, settled: Settled): boolean {
  return life.contour === 'ladder' && life.started && !life.closed && life.freeRow !== null && !settled.merged.has(life.cardId)
}

export function launchableCard(db: DatabaseSync, cardId: number): LaunchableCard | null {
  const life = cardLives(db).get(cardId)
  if (life === undefined || life.lane === null || (fallCounts(db).get(cardId) ?? 0) >= FALLS_BEFORE_CUT)
    return null
  const settled = settledCards(db, cardSet(db, MERGED_CARDS))
  return isQueued(life, settled) || reviewDue(life, settled) ? { lane: life.lane, contour: life.contour } : null
}

function cardsWithLiveTree(db: DatabaseSync, treeLive: TreeReader): Set<number> {
  return new Set((db.prepare(STARTED_TREES).all() as { card_id: number, worktree: string }[]).filter(row => treeLive(row.worktree)).map(row => row.card_id))
}

function heldOutside(life: CardLife, openPrs: Set<number>, liveTrees: Set<number>): boolean {
  return openPrs.has(life.cardId) || (life.contour === 'cheap' && liveTrees.has(life.cardId))
}

export function launchCandidates(db: DatabaseSync, treeLive: TreeReader = existsSync): LaunchCandidate[] {
  const lives = cardLives(db)
  const merged = cardSet(db, MERGED_CARDS)
  const settled = settledCards(db, merged)
  const launching = cardSet(db, OPEN_LAUNCHES)
  const openPrs = cardSet(db, OPEN_PR_CARDS)
  const liveTrees = cardsWithLiveTree(db, treeLive)
  const ended = cardSet(db, ENDED_CARDS)
  const falls = fallCounts(db)
  const busy = new Set<string>()
  const taken: ShiftTask[] = []
  for (const life of lives.values()) {
    const running = life.started && !life.closed && !merged.has(life.cardId) && !ended.has(life.cardId)
    if (life.lane !== null && (running || launching.has(life.cardId)))
      busy.add(life.lane)
    if ((running || launching.has(life.cardId)) && life.task !== null)
      taken.push(life.task)
  }
  const chosen: LaunchCandidate[] = []
  for (const life of [...lives.values()].sort((a, b) => a.cardId - b.cardId)) {
    if ((falls.get(life.cardId) ?? 0) >= FALLS_BEFORE_CUT)
      continue
    if (reviewDue(life, settled)) {
      if (!launching.has(life.cardId))
        chosen.push({ cardId: life.cardId, generation: `${life.generation}:ghost-${life.freeRow}` })
      continue
    }
    if (!isQueued(life, settled) || life.lane === null || busy.has(life.lane) || !life.depends.every(card => merged.has(card)) || overlapsAny(life.task, taken) || heldOutside(life, openPrs, liveTrees))
      continue
    busy.add(life.lane)
    if (life.task !== null)
      taken.push(life.task)
    chosen.push({ cardId: life.cardId, generation: life.generation })
  }
  return chosen
}

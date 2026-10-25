import type { DatabaseSync } from 'node:sqlite'
import type { ShiftTask } from '../../../src/card/task-file.js'
import { existsSync } from 'node:fs'
import { parseParkingFile } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { NOT_A_BACKFILL } from '../../core/backfill-source.js'
import { CARD_BODIES } from '../../core/card-bodies.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_FELL, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, GHOST_ROW, PR_CLOSED, PR_OBSERVED, PR_OPENED, SESSION_HEARTBEAT, TASK_REQUEUED } from '../../core/events.js'
import { prOf } from '../../core/identifiers.js'
import { namesQueueLive } from '../../policy/live-decision.js'
import { beatsLive } from '../../supervisor/liveness-sites.js'
import { currentLane, heldByStall, stalledCards } from './lane-assign.js'
import { taskConflicts } from './overlap.js'

export const FALLS_BEFORE_CUT = 2

export type Contour = 'cheap' | 'ladder'

const FREE_ROW = 'free'

const FAULT = 'fault'

const REQUEUED_BY_REQUEST = `(type = '${TASK_REQUEUED}' AND json_extract(payload, '$.queue') = 'launch' AND json_type(payload, '$.request') = 'integer')`

const CARD_LIFE = `
  SELECT id, type, card_id, pr, dedupe_key, payload FROM events
  WHERE legacy = 0 AND card_id IS NOT NULL AND (type IN ('${CARD_ADMITTED}', '${CARD_STARTED}', '${CARD_CLOSED}', '${CARD_STOPPED}', '${CARD_DROPPED}', '${GHOST_ROW}', '${PR_OPENED}', '${PR_OBSERVED}', '${PR_CLOSED}') OR ${REQUEUED_BY_REQUEST})
    AND ${NOT_A_BACKFILL}
  ORDER BY id
`

const PULL_REQUEST_ROWS = new Set<string>([PR_OPENED, PR_OBSERVED, PR_CLOSED])

const FALLS = `
  SELECT card_id, count(*) AS falls FROM events
  WHERE card_id IS NOT NULL AND ((legacy = 0 AND type = '${CARD_FELL}') OR (legacy = 1 AND type = 'fall'))
  GROUP BY card_id
`

const MERGED_CARDS = `SELECT DISTINCT card_id FROM prs WHERE state = 'merged' AND card_id IS NOT NULL`

const PROBES_VERIFIED_BY_REPORT = `SELECT DISTINCT card_id FROM events WHERE legacy = 0 AND type = '${CARD_VERIFIED}' AND pr IS NULL AND card_id IS NOT NULL AND json_extract(payload, '$.report') IS NOT NULL`

const LEGACY_MERGED_CARDS = `SELECT DISTINCT card_id FROM events WHERE legacy = 1 AND card_id IS NOT NULL AND type = 'merge'`

const LEGACY_LATEST_START_OR_CLOSE = `SELECT card_id, MAX(id) AS id FROM events WHERE legacy = 1 AND card_id IS NOT NULL AND type = 'path' GROUP BY card_id`

const ADMISSION_SOURCE = `SELECT id FROM events WHERE legacy = 1 AND dedupe_key = ?`

const LIVE_DECISIONS = `SELECT text, event_id FROM decisions`

const OPEN_LAUNCHES = `SELECT card_id FROM tasks WHERE queue = 'launch' AND state IN ('queued', 'leased')`

const OPEN_PR_CARDS = `SELECT DISTINCT card_id FROM prs WHERE state = 'open' AND card_id IS NOT NULL`

const ENDED_CARDS = `SELECT card_id FROM cards WHERE state IN ('dropped', 'closed', 'merged', 'stopped')`

const NO_LONGER_CANDIDATES = `SELECT card_id FROM cards WHERE state IN ('dropped', 'closed', 'merged')`

const STARTED_TREES = `
  SELECT card_id, json_extract(payload, '$.worktree') AS worktree FROM events
  WHERE legacy = 0 AND type = '${CARD_STARTED}' AND card_id IS NOT NULL AND json_valid(payload) AND json_type(payload, '$.worktree') = 'text'
  ORDER BY id
`

const LATEST_ADMISSION = `
  SELECT id, payload FROM events
  WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND card_id = ? AND ${NOT_A_BACKFILL}
  ORDER BY id DESC LIMIT 1
`

const FOLDED_BODY = `SELECT admission_event_id FROM ${CARD_BODIES} WHERE card_id = ?`

const LAST_SESSION_BEATS = `
  SELECT card_id, max(ts) AS ts FROM events
  WHERE legacy = 0 AND type = '${SESSION_HEARTBEAT}' AND card_id IS NOT NULL
  GROUP BY card_id
`

export type TreeReader = (worktree: string) => boolean

interface LifeRow {
  id: number
  type: string
  card_id: number
  pr: number | null
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
  continueIn?: string
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
  stoppedByFault: boolean
  closedUnmergedByPr: Map<number, boolean>
}

function closesUnmerged(row: LifeRow): boolean {
  return row.type === PR_CLOSED && payloadOf(row).merged === false
}

function endedByClosedPullRequest(life: CardLife): boolean {
  const closes = [...life.closedUnmergedByPr.values()]
  return closes.length > 0 && closes.every(Boolean)
}

function runs(life: CardLife): boolean {
  return life.started && !life.closed && !endedByClosedPullRequest(life)
}

function payloadOf(row: Pick<LifeRow, 'payload'>): Record<string, unknown> {
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

function carriesABody(payload: Record<string, unknown>): boolean {
  return typeof payload.text === 'string' && payload.textSha === textSha(payload.text)
}

export function bodyNotFoldedYet(db: DatabaseSync, cardId: number): boolean {
  const admission = db.prepare(LATEST_ADMISSION).get(cardId) as { id: number, payload: string } | undefined
  if (admission === undefined || !carriesABody(payloadOf({ payload: admission.payload })))
    return false
  const folded = db.prepare(FOLDED_BODY).get(cardId) as { admission_event_id: number } | undefined
  return folded === undefined || Number(folded.admission_event_id) < Number(admission.id)
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
      const running = life !== undefined && runs(life)
      const admitted = admittedAtOf(db, row, payload)
      const beforeLive = admitted.legacyLine && cutoff !== null && admitted.at < cutoff
      lives.set(row.card_id, { cardId: row.card_id, generation: generationOf(row, payload), admittedAt: admitted.at, lane: laneOf(payload), task: taskOf(row, payload), depends: dependsOf(payload), contour: contourOf(payload), started: running, startedAt: null, freeRow: null, closed: beforeLive, stoppedByFault: false, closedUnmergedByPr: running ? life.closedUnmergedByPr : new Map() })
      continue
    }
    if (life !== undefined && PULL_REQUEST_ROWS.has(row.type)) {
      if (row.pr !== null)
        life.closedUnmergedByPr.set(row.pr, closesUnmerged(row))
      continue
    }
    if (life !== undefined && row.type === TASK_REQUEUED) {
      if (life.stoppedByFault && payloadOf(row).generation === life.generation) {
        life.started = false
        life.closed = false
        life.stoppedByFault = false
      }
      continue
    }
    if (life !== undefined && row.type === CARD_STARTED) {
      life.started = true
      life.startedAt = row.id
      life.freeRow = null
    }
    if (life !== undefined && row.type === GHOST_ROW && life.startedAt !== null && life.freeRow === null && payloadOf(row).state === FREE_ROW)
      life.freeRow = row.id
    if (life !== undefined && (row.type === CARD_CLOSED || row.type === CARD_STOPPED || row.type === CARD_DROPPED)) {
      life.closed = true
      life.stoppedByFault = row.type === CARD_STOPPED && payloadOf(row).reason === FAULT
    }
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
  if (life === undefined || life.lane === null || (fallCounts(db).get(cardId) ?? 0) >= FALLS_BEFORE_CUT || cardSet(db, NO_LONGER_CANDIDATES).has(cardId))
    return null
  const settled = settledCards(db, cardSet(db, MERGED_CARDS))
  return isQueued(life, settled) || reviewDue(life, settled) ? { lane: life.lane, contour: life.contour } : null
}

function standingTrees(db: DatabaseSync, treeLive: TreeReader): Map<number, string> {
  return new Map((db.prepare(STARTED_TREES).all() as { card_id: number, worktree: string }[]).filter(row => treeLive(row.worktree)).map(row => [row.card_id, row.worktree]))
}

function cardsBeatingLive(db: DatabaseSync, nowMs: number): Set<number> {
  return new Set((db.prepare(LAST_SESSION_BEATS).all() as { card_id: number, ts: string }[]).filter(row => beatsLive(row.ts, nowMs)).map(row => row.card_id))
}

function heldOutside(life: CardLife, openPrs: Set<number>, trees: Map<number, string>, beating: Set<number>): boolean {
  return openPrs.has(life.cardId) || (life.contour === 'cheap' && trees.has(life.cardId) && beating.has(life.cardId))
}

function continuedTree(life: CardLife, trees: Map<number, string>): { continueIn?: string } {
  const tree = life.contour === 'cheap' ? trees.get(life.cardId) : undefined
  return tree === undefined ? {} : { continueIn: tree }
}

export type OverlapCatch = (cardId: number, generation: string) => void

function withAssignedLanes(db: DatabaseSync, lives: Map<number, CardLife>): Map<number, CardLife> {
  for (const life of lives.values())
    life.lane = currentLane(db, life.cardId) ?? life.lane
  return lives
}

export function launchCandidates(db: DatabaseSync, treeLive: TreeReader = existsSync, now: () => number = Date.now, onOverlap: OverlapCatch = () => {}): LaunchCandidate[] {
  const lives = withAssignedLanes(db, cardLives(db))
  const merged = cardSet(db, MERGED_CARDS)
  const settled = settledCards(db, merged)
  const cleared = new Set([...merged, ...cardSet(db, PROBES_VERIFIED_BY_REPORT)])
  const launching = cardSet(db, OPEN_LAUNCHES)
  const openPrs = cardSet(db, OPEN_PR_CARDS)
  const trees = standingTrees(db, treeLive)
  const beating = cardsBeatingLive(db, now())
  const ended = cardSet(db, ENDED_CARDS)
  const noLongerCandidates = cardSet(db, NO_LONGER_CANDIDATES)
  const falls = fallCounts(db)
  const stalled = new Set(stalledCards(db).map(stall => stall.cardId))
  const busy = new Set<string>()
  const heldByStalls = new Map<string, CardLife[]>()
  const taken: ShiftTask[] = []
  for (const life of lives.values()) {
    const running = runs(life) && !merged.has(life.cardId) && !ended.has(life.cardId)
    if (life.lane !== null && stalled.has(life.cardId))
      heldByStalls.set(life.lane, [...(heldByStalls.get(life.lane) ?? []), life])
    else if (life.lane !== null && (running || launching.has(life.cardId)))
      busy.add(life.lane)
    if ((running || launching.has(life.cardId)) && life.task !== null)
      taken.push(life.task)
  }
  const chosen: LaunchCandidate[] = []
  for (const life of [...lives.values()].sort((a, b) => a.cardId - b.cardId)) {
    if ((falls.get(life.cardId) ?? 0) >= FALLS_BEFORE_CUT || noLongerCandidates.has(life.cardId))
      continue
    if (reviewDue(life, settled)) {
      if (!launching.has(life.cardId))
        chosen.push({ cardId: life.cardId, generation: `${life.generation}:ghost-${life.freeRow}` })
      continue
    }
    if (!isQueued(life, settled) || life.lane === null || busy.has(life.lane) || heldByStall(life, heldByStalls.get(life.lane) ?? []) || !life.depends.every(card => cleared.has(card)) || heldOutside(life, openPrs, trees, beating))
      continue
    if (bodyNotFoldedYet(db, life.cardId))
      continue
    if (overlapsAny(life.task, taken)) {
      onOverlap(life.cardId, life.generation)
      continue
    }
    busy.add(life.lane)
    if (life.task !== null)
      taken.push(life.task)
    chosen.push({ cardId: life.cardId, generation: life.generation, ...continuedTree(life, trees) })
  }
  return chosen
}

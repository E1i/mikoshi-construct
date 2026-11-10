import type { DatabaseSync } from 'node:sqlite'
import type { ParkedTask, Priority } from '../../../src/card/parking.js'
import type { ShiftTask } from '../../../src/card/task-file.js'
import type { MachineSessions } from '../../core/machine-sessions.js'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { parseParkingFile, WINDOW_WHO } from '../../../src/card/parking.js'
import { NOT_A_BACKFILL } from '../../core/backfill-source.js'
import { DEFERRED_CARD, unsatisfiedDependencies } from '../../core/card-automaton.js'
import { bodyNotFoldedYet } from '../../core/card-bodies.js'
import { cardHoldOf } from '../../core/card-hold.js'
import { DECISION_IN_FORCE } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_FELL, CARD_STARTED, CARD_STOPPED, GHOST_ROW, PR_CLOSED, PR_OBSERVED, PR_OPENED, SESSION_HEARTBEAT, TASK_REQUEUED } from '../../core/events.js'
import { prOf } from '../../core/identifiers.js'
import { busNameOfDb, machineHoldLine, machineSessions } from '../../core/machine-sessions.js'
import { namesQueueLive } from '../../policy/live-decision.js'
import { isAlive } from '../../quality/lock.js'
import { beatsLive } from '../../supervisor/liveness-sites.js'
import { chainLaneNumber, currentLane, heldByStall, repositoryLanes, stalledCards, startOrder } from './lane-assign.js'
import { taskConflicts } from './overlap.js'
import { sharedAppendFiles } from './shared-files.js'

export const FALLS_BEFORE_CUT = 2
export const PLANNED_STALL_MINUTES = 15
const MINUTE_MS = 60_000

export type Contour = 'cheap' | 'ladder'

const FREE_ROW = 'free'

const FAULT = 'fault'

const REQUEUED_BY_REQUEST = `(type = '${TASK_REQUEUED}' AND json_extract(payload, '$.queue') = 'launch' AND json_type(payload, '$.request') = 'integer')`

const CARD_LIFE = `
  SELECT id, ts, type, card_id, pr, dedupe_key, payload FROM events
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

const LEGACY_MERGED_CARDS = `SELECT DISTINCT card_id FROM events WHERE legacy = 1 AND card_id IS NOT NULL AND type = 'merge'`

const LEGACY_LATEST_START_OR_CLOSE = `SELECT card_id, MAX(id) AS id FROM events WHERE legacy = 1 AND card_id IS NOT NULL AND type = 'path' GROUP BY card_id`

const ADMISSION_SOURCE = `SELECT id FROM events WHERE legacy = 1 AND dedupe_key = ?`

const LIVE_DECISIONS = `SELECT text, event_id FROM decisions WHERE state = '${DECISION_IN_FORCE}'`

const OPEN_LAUNCHES = `SELECT card_id FROM tasks WHERE queue = 'launch' AND state IN ('queued', 'leased')`

const OPEN_PR_CARDS = `SELECT DISTINCT card_id FROM prs WHERE state = 'open' AND card_id IS NOT NULL`

const OPEN_PR_NUMBERS = `SELECT card_id, pr FROM prs WHERE state = 'open' AND card_id IS NOT NULL ORDER BY pr DESC`

const ENDED_CARDS = `SELECT card_id FROM cards WHERE state IN ('dropped', 'closed', 'merged', 'stopped')`

const NO_LONGER_CANDIDATES = `SELECT card_id FROM cards WHERE state IN ('dropped', 'closed', 'merged', '${DEFERRED_CARD}')`

const STARTED_TREES = `
  SELECT card_id, json_extract(payload, '$.worktree') AS worktree FROM events
  WHERE legacy = 0 AND type = '${CARD_STARTED}' AND card_id IS NOT NULL AND json_valid(payload) AND json_type(payload, '$.worktree') = 'text'
  ORDER BY id
`

const LAST_SESSION_BEATS = `
  SELECT card_id, max(ts) AS ts FROM events
  WHERE legacy = 0 AND type = '${SESSION_HEARTBEAT}' AND card_id IS NOT NULL
  GROUP BY card_id
`

export type TreeReader = (worktree: string) => boolean

interface LifeRow {
  id: number
  ts: string
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
  admittedTs: string
  lane: string | null
  task: ShiftTask | null
  windowsToWork: boolean
  depends: number[]
  priority: Priority | null
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

function parkedOf(row: LifeRow, payload: Record<string, unknown>): ParkedTask | null {
  if (typeof payload.text !== 'string')
    return null
  const parsed = parseParkingFile(`${row.card_id}.md`, payload.text)
  return parsed.kind === 'parked' ? parsed.parked : null
}

function conflicting(task: ShiftTask | null, other: ShiftTask | null, shared: readonly string[]): boolean {
  return task !== null && other !== null && taskConflicts([other, task], shared).length > 0
}

function overlappingPath(task: ShiftTask, other: ShiftTask | null, shared: readonly string[]): string {
  return task.touches.find(touch => conflicting({ ...task, touches: [touch] }, other, shared)) ?? task.touches[0]!
}

function overlapsAny(task: ShiftTask | null, taken: readonly ShiftTask[], shared: readonly string[]): boolean {
  return taken.some(other => conflicting(task, other, shared))
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
      const parked = parkedOf(row, payload)
      lives.set(row.card_id, { cardId: row.card_id, generation: generationOf(row, payload), admittedAt: admitted.at, admittedTs: row.ts, lane: laneOf(payload), task: parked?.task ?? null, windowsToWork: parked?.who === WINDOW_WHO, depends: dependsOf(payload), priority: parked?.priority ?? null, contour: contourOf(payload), started: running, startedAt: null, freeRow: null, closed: beforeLive, stoppedByFault: false, closedUnmergedByPr: running ? life.closedUnmergedByPr : new Map() })
      continue
    }
    if (life !== undefined && PULL_REQUEST_ROWS.has(row.type)) {
      if (row.pr !== null)
        life.closedUnmergedByPr.set(row.pr, closesUnmerged(row))
      continue
    }
    if (life !== undefined && row.type === TASK_REQUEUED) {
      if (life.stoppedByFault) {
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
  if (life === undefined || life.lane === null || life.windowsToWork || (fallCounts(db).get(cardId) ?? 0) >= FALLS_BEFORE_CUT || cardSet(db, NO_LONGER_CANDIDATES).has(cardId))
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

export interface LaunchCatch {
  (cardId: number, generation: string): void
  skipped: (cardId: number, reason: string) => void
}

function withAssignedLanes(db: DatabaseSync, lives: Map<number, CardLife>): Map<number, CardLife> {
  for (const life of lives.values())
    life.lane = currentLane(db, life.cardId) ?? life.lane
  return lives
}

interface Holds {
  holding: CardLife[]
  busy: CardLife[]
  heldByStalls: Map<string, CardLife[]>
}

function holdsOf(db: DatabaseSync, lives: ReadonlyMap<number, CardLife>, merged: ReadonlySet<number>, openPrs: ReadonlySet<number>): Holds {
  const launching = cardSet(db, OPEN_LAUNCHES)
  const ended = cardSet(db, ENDED_CARDS)
  const stalled = new Set(stalledCards(db).map(stall => stall.cardId))
  const holds: Holds = { holding: [], busy: [], heldByStalls: new Map() }
  for (const life of lives.values()) {
    const running = runs(life) && !merged.has(life.cardId) && !ended.has(life.cardId)
    const holding = running || launching.has(life.cardId) || openPrs.has(life.cardId)
    if (life.lane !== null && stalled.has(life.cardId))
      holds.heldByStalls.set(life.lane, [...(holds.heldByStalls.get(life.lane) ?? []), life])
    else if (life.lane !== null && holding)
      holds.busy.push(life)
    if (holding)
      holds.holding.push(life)
  }
  return holds
}

export type StartableHold
  = { kind: 'open-pr', pr: number, path: string }
    | { kind: 'session', cardId: number, path: string }
    | { kind: 'lane', cardId: number, lane: string }
    | { kind: 'slots' }
    | { kind: 'machine', live: number, limit: number }
    | { kind: 'lane-outside', lane: string, lanes: number }

export type MachineReader = Pick<MachineSessions, 'free' | 'held' | 'waiting'>

export function holdReason(hold: StartableHold): string {
  switch (hold.kind) {
    case 'machine':
      return machineHoldLine(hold)
    case 'lane-outside':
      return `${hold.lane} is outside the ${hold.lanes} lanes this repository runs; the card starts once it is moved into a lane within that count or the count grows`
    case 'open-pr':
      return `overlap with open PR #${hold.pr} on ${hold.path}`
    case 'session':
      return `overlap with the session of #${hold.cardId} on ${hold.path}`
    case 'lane':
      return `#${hold.cardId} at the head of ${hold.lane}`
    case 'slots':
      return 'occupied slots'
  }
}

export interface StartableCard {
  cardId: number
  admittedTs: string
  hold: StartableHold
}

function openPrNumbers(db: DatabaseSync): Map<number, number> {
  return new Map((db.prepare(OPEN_PR_NUMBERS).all() as { card_id: number, pr: number }[]).map(row => [row.card_id, row.pr]))
}

function outsideTheLanes(lane: string | null, lanes: number): boolean {
  const number = lane === null ? null : chainLaneNumber(lane)
  return number !== null && number > lanes
}

function machineHoldOf(machine: MachineReader): StartableHold | null {
  const held = machine.held()
  return held === null ? null : { kind: 'machine', ...held }
}

function holdOf(life: CardLife, holds: Holds, openPrs: ReadonlyMap<number, number>, shared: readonly string[], lanes: number, machine: MachineReader): StartableHold {
  const overlapping = holds.holding.find(holder => holder.cardId !== life.cardId && conflicting(life.task, holder.task, shared))
  if (overlapping !== undefined) {
    const path = overlappingPath(life.task!, overlapping.task, shared)
    const pr = openPrs.get(overlapping.cardId)
    return pr === undefined ? { kind: 'session', cardId: overlapping.cardId, path } : { kind: 'open-pr', pr, path }
  }
  if (life.lane === null)
    return machineHoldOf(machine) ?? { kind: 'slots' }
  if (outsideTheLanes(life.lane, lanes))
    return { kind: 'lane-outside', lane: life.lane, lanes }
  const stalling = (holds.heldByStalls.get(life.lane) ?? []).find(holder => heldByStall(life, [holder], shared))
  const keeping = stalling ?? holds.busy.find(holder => holder.lane === life.lane && holder.cardId !== life.cardId)
  if (keeping !== undefined)
    return { kind: 'lane', cardId: keeping.cardId, lane: life.lane }
  return machineHoldOf(machine) ?? { kind: 'slots' }
}

export function startHold(db: DatabaseSync, cardId: number, lanes: number, machine: MachineReader): StartableHold | null {
  const life = withAssignedLanes(db, cardLives(db)).get(cardId)
  if (life !== undefined && outsideTheLanes(life.lane, lanes) && isQueued(life, settledCards(db, cardSet(db, MERGED_CARDS))))
    return { kind: 'lane-outside', lane: life.lane!, lanes }
  return machineHoldOf(machine)
}

export function startableCards(db: DatabaseSync, treeLive: TreeReader = existsSync, now: () => number = Date.now, shared: readonly string[] = sharedAppendFiles(), lanes: () => number = repositoryLanes(process.cwd()), machine: MachineReader = machineSessions(isAlive)): StartableCard[] {
  const lives = withAssignedLanes(db, cardLives(db))
  const merged = cardSet(db, MERGED_CARDS)
  const settled = settledCards(db, merged)
  const unsatisfied = unsatisfiedDependencies(db)
  const openPrs = cardSet(db, OPEN_PR_CARDS)
  const trees = standingTrees(db, treeLive)
  const beating = cardsBeatingLive(db, now())
  const noLongerCandidates = cardSet(db, NO_LONGER_CANDIDATES)
  const falls = fallCounts(db)
  const holds = holdsOf(db, lives, merged, openPrs)
  const prNumbers = openPrNumbers(db)
  return [...lives.values()]
    .filter(life => !noLongerCandidates.has(life.cardId) && !life.windowsToWork && (falls.get(life.cardId) ?? 0) < FALLS_BEFORE_CUT && isQueued(life, settled) && unsatisfied(life.depends).length === 0 && !heldOutside(life, openPrs, trees, beating) && cardHoldOf(db, life.cardId) === null)
    .map(life => ({ cardId: life.cardId, admittedTs: life.admittedTs, hold: holdOf(life, holds, prNumbers, shared, lanes(), machine) }))
}

export interface PlannedStall extends StartableCard {
  minutes: number
}

function minutesSince(ts: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(ts)) / MINUTE_MS)
}

function showsAtOnce(hold: StartableHold): boolean {
  return hold.kind === 'machine' || hold.kind === 'lane-outside'
}

function startableStalls(db: DatabaseSync, nowMs: number, treeLive: TreeReader, shared: readonly string[], lanes: () => number, machine: MachineReader): PlannedStall[] {
  return startableCards(db, treeLive, () => nowMs, shared, lanes, machine)
    .map(card => ({ ...card, minutes: minutesSince(card.admittedTs, nowMs) }))
    .filter(card => card.minutes >= PLANNED_STALL_MINUTES || showsAtOnce(card.hold))
}

function heldSessions(db: DatabaseSync, nowMs: number, machine: MachineReader): PlannedStall[] {
  const hold = machineHoldOf(machine)
  if (hold === null)
    return []
  return machine.waiting(busNameOfDb(db)).map(waiter => ({ cardId: waiter.cardId, admittedTs: waiter.since, hold, minutes: minutesSince(waiter.since, nowMs) }))
}

export function plannedStalls(db: DatabaseSync, nowMs: number, treeLive: TreeReader = existsSync, shared: readonly string[] = sharedAppendFiles(), lanes: () => number = repositoryLanes(process.cwd()), machine: MachineReader = machineSessions(isAlive)): PlannedStall[] {
  return [...startableStalls(db, nowMs, treeLive, shared, lanes, machine), ...heldSessions(db, nowMs, machine)]
}

function logSkips(db: DatabaseSync, onSkip: LaunchCatch['skipped'], launching: ReadonlySet<number>, nowMs: number, treeLive: TreeReader, shared: readonly string[], lanes: () => number, machine: MachineReader): void {
  for (const card of startableStalls(db, nowMs, treeLive, shared, lanes, machine)) {
    if (card.hold.kind !== 'slots' || launching.has(card.cardId))
      onSkip(card.cardId, holdReason(card.hold))
  }
}

export function launchCandidates(db: DatabaseSync, treeLive: TreeReader = existsSync, now: () => number = Date.now, onOverlap: OverlapCatch | LaunchCatch = () => {}, shared: readonly string[] = sharedAppendFiles(), lanes: () => number = repositoryLanes(process.cwd()), machine: MachineReader = machineSessions(isAlive)): LaunchCandidate[] {
  const lives = withAssignedLanes(db, cardLives(db))
  const laneLimit = lanes()
  let free = machine.free()
  const merged = cardSet(db, MERGED_CARDS)
  const settled = settledCards(db, merged)
  const unsatisfied = unsatisfiedDependencies(db)
  const launching = cardSet(db, OPEN_LAUNCHES)
  const openPrs = cardSet(db, OPEN_PR_CARDS)
  const trees = standingTrees(db, treeLive)
  const beating = cardsBeatingLive(db, now())
  const noLongerCandidates = cardSet(db, NO_LONGER_CANDIDATES)
  const falls = fallCounts(db)
  const { holding, busy: busyCards, heldByStalls } = holdsOf(db, lives, merged, openPrs)
  const busy = new Set(busyCards.map(life => life.lane))
  const taken = holding.flatMap(life => life.task ?? [])
  const chosen: LaunchCandidate[] = []
  const open = [...lives.values()].filter(life => !noLongerCandidates.has(life.cardId))
  for (const life of open.sort(startOrder(open))) {
    if (life.windowsToWork || (falls.get(life.cardId) ?? 0) >= FALLS_BEFORE_CUT || cardHoldOf(db, life.cardId) !== null)
      continue
    if (reviewDue(life, settled)) {
      if (!launching.has(life.cardId) && free > 0) {
        free -= 1
        chosen.push({ cardId: life.cardId, generation: `${life.generation}:ghost-${life.freeRow}` })
      }
      continue
    }
    if (!isQueued(life, settled) || life.lane === null || outsideTheLanes(life.lane, laneLimit) || busy.has(life.lane) || heldByStall(life, heldByStalls.get(life.lane) ?? [], shared) || unsatisfied(life.depends).length > 0 || heldOutside(life, openPrs, trees, beating))
      continue
    if (bodyNotFoldedYet(db, life.cardId))
      continue
    if (overlapsAny(life.task, taken, shared)) {
      onOverlap(life.cardId, life.generation)
      continue
    }
    if (free <= 0)
      continue
    free -= 1
    busy.add(life.lane)
    if (life.task !== null)
      taken.push(life.task)
    chosen.push({ cardId: life.cardId, generation: life.generation, ...continuedTree(life, trees) })
  }
  if ('skipped' in onOverlap)
    logSkips(db, onOverlap.skipped, launching, now(), treeLive, shared, lanes, machine)
  return chosen
}

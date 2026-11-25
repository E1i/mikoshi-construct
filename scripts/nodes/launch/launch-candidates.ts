import type { DatabaseSync } from 'node:sqlite'
import type { ParkedTask, Priority } from '../../../src/card/parking.js'
import type { ShiftTask } from '../../../src/card/task-file.js'
import type { SessionStopCode } from '../../core/card-hold.js'
import type { EventRow } from '../../core/events-query.js'
import type { MachineHold, MachineSessions } from '../../core/machine-sessions.js'
import type { QueuedTask, QueueSource } from '../../core/queue.js'
import type { Holder } from './holders.js'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { parseParkingFile, PRIORITIES, WINDOW_WHO } from '../../../src/card/parking.js'
import { isBackfill } from '../../core/backfill-source.js'
import { BUS_CONTRACT } from '../../core/bus-adapter.js'
import { DEFERRED_CARD, unsatisfiedDependencies } from '../../core/card-automaton.js'
import { bodyNotFoldedYet, pathsOutsideTheBody } from '../../core/card-bodies.js'
import { cardHoldOf, SESSION_STOP_CODES } from '../../core/card-hold.js'
import { cardsWithAState, closedWaitsOfCard, openOwnerWaits } from '../../core/card-readings.js'
import { appendEvent, openOwnerWait } from '../../core/db.js'
import { BY_CARD, EITHER_JOURNAL, events, lastPer } from '../../core/events-query.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_FELL, CARD_STARTED, CARD_STOPPED, CARD_WAITING, COMMAND_EXECUTED, DECISION_RECORDED, GHOST_ROW, LANE_HELD, OUTSIDE_TOUCHES, OWNER_WAIT_OPENED, PR_CLOSED, PR_OBSERVED, PR_OPENED, SESSION_HEARTBEAT, TASK_REQUEUED } from '../../core/events.js'
import { prOf } from '../../core/identifiers.js'
import { legacyHistory } from '../../core/legacy-history.js'
import { busNameOfDb, machineHoldLine, machineSessions } from '../../core/machine-sessions.js'
import * as prs from '../../core/pr-readings.js'
import { ofQueue } from '../../core/tasks-query.js'
import { decisionRecordedAfter, inForceDecisions } from '../../policy/decisions/index.js'
import { namesQueueLive } from '../../policy/live-decision.js'
import { ANY, BusRead } from '../../ports/bus-read.js'
import { isAlive } from '../../quality/lock.js'
import { beatsLive } from '../../supervisor/liveness-sites.js'
import { holderOf, HoldRule, observedDiff, unclearField, withDiff } from './holders.js'
import { chainLaneNumber, currentLane, heldByStall, ownerMergeHolders, repositoryLanes, stalledCards, startOrder, withoutDerived } from './lane-assign.js'
import { taskConflicts } from './overlap.js'
import { sharedAppendFiles } from './shared-files.js'

export const FALLS_BEFORE_CUT = 2
export const PLANNED_STALL_MINUTES = 15
export const HELD_AT_THE_EXIT = 'held'
const MINUTE_MS = 60_000
const HOLDS = new HoldRule(PRIORITIES)

export type Contour = 'cheap' | 'ladder'

const FREE_ROW = 'free'

const FAULT = 'fault'

const CARD_LIFE_TYPES = [CARD_ADMITTED, CARD_STARTED, CARD_CLOSED, CARD_STOPPED, CARD_DROPPED, GHOST_ROW, PR_OPENED, PR_OBSERVED, PR_CLOSED, TASK_REQUEUED]

function inTheCardLife(row: EventRow): boolean {
  return !isBackfill(row.data ?? {}) && (row.type !== TASK_REQUEUED || (row.data?.queue === 'launch' && Number.isInteger(row.data.request)))
}

function cardLifeRows(db: DatabaseSync): LifeRow[] {
  return events(db, { types: CARD_LIFE_TYPES, withCard: true }).filter(inTheCardLife).map(row => ({ ...row, card_id: row.card_id! }))
}

const PULL_REQUEST_ROWS = new Set<string>([PR_OPENED, PR_OBSERVED, PR_CLOSED])
const LEGACY_FALL = 'fall'
const OPEN_TASK_STATES: readonly string[] = ['queued', 'leased']

type CardRead = (db: DatabaseSync) => Iterable<number>

const openCardPrs = (db: DatabaseSync): prs.PrRow[] => prs.all(db).filter(row => row.state === 'open' && row.card_id !== null)
const cardsInStates = (states: readonly string[]): CardRead => db => [...cardsWithAState(db)].filter(([, state]) => states.includes(state)).map(([cardId]) => cardId)
const MERGED_CARDS: CardRead = prs.mergedCards
const LEGACY_MERGED_CARDS: CardRead = db => events(db, { types: ['merge'], withCard: true, legacy: true }).map(row => row.card_id!)
const OPEN_LAUNCHES: CardRead = db => ofQueue(db, 'launch').filter(task => OPEN_TASK_STATES.includes(task.state)).map(task => task.card_id)
const OPEN_PR_CARDS: CardRead = db => openCardPrs(db).map(row => row.card_id!)
const ENDED_CARDS = cardsInStates(['dropped', 'closed', 'merged', 'stopped'])
const NO_LONGER_CANDIDATES = cardsInStates(['dropped', 'closed', 'merged', DEFERRED_CARD])
const AMEND_SOURCE = 'amend'

export type TreeReader = (worktree: string) => boolean

export interface HeldSessionStop {
  code: SessionStopCode
  stop: number
  paths: string[]
}

export interface WindowQuestion {
  question: string
  decision: string
}

const WINDOW_QUESTION_LINE = /^window-question:([^·\n]+)·[ \t]*(D-\d+)[ \t]*$/gm

export function reportedWindowQuestions(report: string | null): WindowQuestion[] {
  return [...(report ?? '').matchAll(WINDOW_QUESTION_LINE)].map(line => ({ question: line[1]!.trim(), decision: line[2]! })).filter(asked => asked.question !== '')
}

function stopCodeOf(value: unknown): SessionStopCode | null {
  return SESSION_STOP_CODES.find(code => code === value) ?? null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : []
}

function decidedOnTheCardSince(bus: BusRead, cardId: number, stop: number): boolean {
  return bus.where({ from: stop + 1 }).slice(DECISION_RECORDED, ['scope']).some(decided => Array.isArray(decided.fields.scope) && decided.fields.scope.includes(cardId))
}

function ownerAnsweredSince(db: DatabaseSync, bus: BusRead, cardId: number, stop: number): boolean {
  return decidedOnTheCardSince(bus, cardId, stop) || closedWaitsOfCard(db, cardId).some(wait => wait.event_id > stop && wait.type !== CARD_ADMITTED)
}

function questionStillOpen(db: DatabaseSync, bus: BusRead, cardId: number, stop: number): boolean {
  if (decidedOnTheCardSince(bus, cardId, stop))
    return false
  const closed = new Set(closedWaitsOfCard(db, cardId).map(wait => wait.id))
  const openedSince = bus.where({ from: stop + 1 }).where({ card: cardId }).slice(OWNER_WAIT_OPENED, ['id'])
  return openedSince.some(opened => !closed.has(String(opened.fields.id)))
}

export function heldSessionStop(db: DatabaseSync, cardId: number): HeldSessionStop | null {
  const bus = new BusRead(db)
  const latest = bus.where({ card: cardId }).slice(CARD_STOPPED, ['code', 'paths'], 'last')[0]
  const stopCode = stopCodeOf(latest?.fields.code)
  if (latest === undefined || stopCode === null)
    return null
  const named = strings(latest.fields.paths)
  if (stopCode === OUTSIDE_TOUCHES) {
    const uncovered = pathsOutsideTheBody(db, cardId, named.join('\n'))
    return uncovered.length === 0 || ownerAnsweredSince(db, bus, cardId, latest.id) ? null : { code: stopCode, stop: latest.id, paths: uncovered }
  }
  return questionStillOpen(db, bus, cardId, latest.id) ? { code: stopCode, stop: latest.id, paths: named } : null
}

export function commandRanSince(db: DatabaseSync, cardId: number, command: string, since?: number): boolean {
  const ofTheCard = new BusRead(db).where({ card: cardId })
  return ofTheCard.where({ from: (since ?? ofTheCard.slice(CARD_STARTED, ['session'], 'last')[0]?.id ?? 0) + 1 }).slice(COMMAND_EXECUTED, ['command']).some(ran => ran.fields.command === command)
}

export function stopsWithCode(db: DatabaseSync, cardId: number, code: string): number {
  return new BusRead(db).where({ card: cardId }).slice(CARD_STOPPED, ['code']).filter(stop => stop.fields.code === code).length
}

export function heldStopLine(cardId: number, held: HeldSessionStop): string {
  const why = held.code === OUTSIDE_TOUCHES ? `its touches still miss ${held.paths.join(', ')}, so it waits for intake to widen them, or for a decision bound to the card or the owner's word closing its wait that no widening is needed` : 'the question it stopped on is still open, so it waits for the decision or the owner wait to close'
  return `${held.code}: card #${cardId} is not launched again since stop ${held.stop}: ${why}`
}

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
  lane: string | null
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
  ended: boolean
  stoppedByFault: boolean
  closedUnmergedByPr: Map<number, boolean>
  diff: string[] | null
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
  return task !== null && other !== null && taskConflicts([withoutDerived(other), withoutDerived(task)], shared).length > 0
}

function overlappingPath(task: ShiftTask, other: ShiftTask | null, shared: readonly string[]): string {
  return task.touches.find(touch => conflicting({ ...task, touches: [touch] }, other, shared)) ?? task.touches[0]!
}

function overlapsAny(life: CardLife, taken: readonly Holder<ShiftTask, Priority>[], shared: readonly string[]): boolean {
  return taken.some(holder => HOLDS.holdsAgainst(holder, life) && conflicting(life.task, holder.task, shared))
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
  const source = events(db, { keys: [payload.admission], legacy: true })[0]
  return { at: source?.id ?? row.id, legacyLine: source !== undefined }
}

function beforeLaunchWentLive(db: DatabaseSync): (at: number) => boolean {
  const live = inForceDecisions(db).filter(decision => namesQueueLive(decision.text, 'launch')).map(decision => decision.decisionId)
  return at => live.length > 0 && live.every(decisionId => decisionRecordedAfter(db, decisionId, at))
}

function cardLives(db: DatabaseSync): Map<number, CardLife> {
  const lives = new Map<number, CardLife>()
  const beforeLive = beforeLaunchWentLive(db)
  for (const row of cardLifeRows(db)) {
    const life = lives.get(row.card_id)
    if (row.type === CARD_ADMITTED) {
      const payload = payloadOf(row)
      const running = life !== undefined && runs(life)
      const admitted = admittedAtOf(db, row, payload)
      const legacyBeforeLive = admitted.legacyLine && beforeLive(admitted.at)
      const parked = parkedOf(row, payload)
      const ended = life?.ended === true && payload.source === AMEND_SOURCE
      lives.set(row.card_id, { cardId: row.card_id, generation: generationOf(row, payload), admittedAt: admitted.at, admittedTs: row.ts, lane: laneOf(payload), task: parked?.task ?? null, windowsToWork: parked?.who === WINDOW_WHO, depends: dependsOf(payload), priority: parked?.priority ?? null, contour: contourOf(payload), started: running, startedAt: null, freeRow: null, closed: legacyBeforeLive || ended, ended, stoppedByFault: false, closedUnmergedByPr: running ? life.closedUnmergedByPr : new Map(), diff: running ? life.diff : null })
      continue
    }
    if (life !== undefined && PULL_REQUEST_ROWS.has(row.type)) {
      if (row.pr !== null)
        life.closedUnmergedByPr.set(row.pr, closesUnmerged(row))
      if (row.type === PR_OBSERVED)
        life.diff = observedDiff(payloadOf(row)) ?? life.diff
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
      life.ended = row.type !== CARD_STOPPED
      life.stoppedByFault = row.type === CARD_STOPPED && payloadOf(row).reason === FAULT
    }
  }
  return lives
}

function cardSet(db: DatabaseSync, read: CardRead): Set<number> {
  return new Set(read(db))
}

interface Settled {
  merged: Set<number>
  latestStartOrClose: Map<number, number>
}

function settledCards(db: DatabaseSync, merged: Set<number>): Settled {
  const latestStartOrClose = new Map(lastPer(db, BY_CARD, { types: ['path'], withCard: true, legacy: true }).map(row => [row.card_id!, row.id]))
  return { merged: new Set([...merged, ...cardSet(db, LEGACY_MERGED_CARDS)]), latestStartOrClose }
}

function startedOrClosedSinceAdmission(life: CardLife, settled: Settled): boolean {
  return (settled.latestStartOrClose.get(life.cardId) ?? 0) > life.admittedAt
}

function isQueued(life: CardLife | undefined, settled: Settled): boolean {
  return life !== undefined && !life.started && !life.closed && !settled.merged.has(life.cardId) && !startedOrClosedSinceAdmission(life, settled)
}

function fallCounts(db: DatabaseSync): Map<number, number> {
  const falls = new Map<number, number>()
  for (const fall of events(db, { types: [CARD_FELL, LEGACY_FALL], withCard: true, legacy: EITHER_JOURNAL }).filter(row => row.type === (row.legacy ? LEGACY_FALL : CARD_FELL)))
    falls.set(fall.card_id!, (falls.get(fall.card_id!) ?? 0) + 1)
  return falls
}

function reviewDue(life: CardLife, settled: Settled): boolean {
  return life.contour === 'ladder' && life.started && !life.closed && life.freeRow !== null && !settled.merged.has(life.cardId)
}

export function launchableCard(db: DatabaseSync, cardId: number): LaunchableCard | null {
  const life = cardLives(db).get(cardId)
  if (life === undefined || life.windowsToWork || (fallCounts(db).get(cardId) ?? 0) >= FALLS_BEFORE_CUT || cardSet(db, NO_LONGER_CANDIDATES).has(cardId))
    return null
  const settled = settledCards(db, cardSet(db, MERGED_CARDS))
  return isQueued(life, settled) || reviewDue(life, settled) ? { lane: life.lane, contour: life.contour } : null
}

function standingTrees(db: DatabaseSync, treeLive: TreeReader): Map<number, string> {
  const started = events(db, { types: [CARD_STARTED], withCard: true }).flatMap(row => typeof row.data?.worktree === 'string' ? [[row.card_id!, row.data.worktree] as const] : [])
  return new Map(started.filter(([, worktree]) => treeLive(worktree)))
}

function cardsBeatingLive(db: DatabaseSync, nowMs: number): Set<number> {
  return new Set(lastPer(db, BY_CARD, { types: [SESSION_HEARTBEAT], withCard: true }).filter(row => beatsLive(row.ts, nowMs)).map(row => row.card_id!))
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
  stamp: { ts: string, actor: string }
}

function lastPerCard(bus: BusRead, type: typeof CARD_ADMITTED | typeof CARD_DROPPED): Map<number, number> {
  return new Map(bus.slice(type, [], 'last-per-card').map(row => [row.card!, row.id]))
}

export function droppedCards(db: DatabaseSync): Set<number> {
  const bus = new BusRead(db).where({ card: ANY })
  const admitted = lastPerCard(bus, CARD_ADMITTED)
  return new Set([...lastPerCard(bus, CARD_DROPPED)].filter(([cardId, drop]) => drop > (admitted.get(cardId) ?? 0)).map(([cardId]) => cardId))
}

export function droppedDependencyWaitText(cardId: number, dropped: number): string {
  return `card #${cardId} depends on #${dropped}, which is dropped, so #${cardId} can never launch and every lane chain leaves it: amend its depends to the card that replaces #${dropped}, or drop #${cardId}`
}

function waitOnDroppedDependencies(db: DatabaseSync, queued: readonly CardLife[], stamp: LaunchCatch['stamp']): void {
  const dropped = droppedCards(db)
  for (const life of queued) {
    const asked = new Set(new BusRead(db).where({ card: life.cardId }).slice(OWNER_WAIT_OPENED, ['text']).map(opened => opened.fields.text))
    for (const parent of life.depends.filter(each => dropped.has(each))) {
      const text = droppedDependencyWaitText(life.cardId, parent)
      if (!asked.has(text))
        openOwnerWait(db, stamp.ts, stamp.actor, { need: 'decision', text, card: life.cardId })
    }
  }
}

function withAssignedLanes(db: DatabaseSync, lives: Map<number, CardLife>): Map<number, CardLife> {
  for (const life of lives.values())
    life.lane = currentLane(db, life.cardId) ?? life.lane
  return lives
}

interface Holds {
  holding: Holder<ShiftTask, Priority>[]
  busy: Holder<ShiftTask, Priority>[]
  heldByStalls: Map<string, Holder<ShiftTask, Priority>[]>
  launching: ReadonlySet<number>
}

function launchHeldByItsQuestion(db: DatabaseSync, cardId: number, beating: ReadonlySet<number>): boolean {
  return !beating.has(cardId) && heldSessionStop(db, cardId) !== null
}

function holdsOf(db: DatabaseSync, lives: ReadonlyMap<number, CardLife>, merged: ReadonlySet<number>, openPrs: ReadonlySet<number>, beating: ReadonlySet<number>): Holds {
  const launching = cardSet(db, OPEN_LAUNCHES)
  const ended = cardSet(db, ENDED_CARDS)
  const stalled = new Set(stalledCards(db).map(stall => stall.cardId))
  const waitingOnOwner = ownerMergeHolders(db)
  const holds: Holds = { holding: [], busy: [], heldByStalls: new Map(), launching }
  for (const life of lives.values()) {
    const running = runs(life) && !merged.has(life.cardId) && !ended.has(life.cardId)
    const launchHolds = launching.has(life.cardId) && !launchHeldByItsQuestion(db, life.cardId, beating)
    const holding = running || launchHolds || openPrs.has(life.cardId)
    const isStalled = life.lane !== null && stalled.has(life.cardId)
    if (!holding && !isStalled)
      continue
    const pullRequestOnly = openPrs.has(life.cardId) && life.diff !== null && !launchHolds && !beating.has(life.cardId)
    const holder = holderOf(life, pullRequestOnly ? withDiff(life.task, life.diff) : life.task, waitingOnOwner.has(life.cardId) || cardHoldOf(db, life.cardId) !== null)
    if (isStalled)
      holds.heldByStalls.set(life.lane!, [...(holds.heldByStalls.get(life.lane!) ?? []), holder])
    else if (life.lane !== null && !pullRequestOnly)
      holds.busy.push(holder)
    if (holding)
      holds.holding.push(holder)
  }
  return holds
}

export type StartableHold
  = { kind: 'open-pr', pr: number, cardId: number, path: string }
    | { kind: 'session', cardId: number, path: string }
    | { kind: 'lane', cardId: number, lane: string }
    | { kind: 'slots' }
    | { kind: 'launching' }
    | { kind: 'unfolded' }
    | { kind: 'window' }
    | { kind: 'unclear', field: string }
    | { kind: 'none' }
    | ({ kind: 'machine' } & MachineHold)
    | { kind: 'lane-outside', lane: string, lanes: number }
    | { kind: 'depends', depends: number }
    | { kind: 'dropped-depends', dropped: number }

export type MachineReader = Pick<MachineSessions, 'free' | 'held' | 'waiting'>

export const UNEXPLAINED_HOLD = 'no holder found: it can start and has not, and the scheduler names no reason'

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
      return 'every session slot of the machine is taken'
    case 'launching':
      return 'its launch is queued and waits for the launch node to take it'
    case 'unfolded':
      return 'its admitted body is not folded into the bus yet'
    case 'window':
      return `who: ${WINDOW_WHO}, so the shift does not take it; the window starts it or hands it to the shift`
    case 'unclear':
      return `who: ${WINDOW_WHO}, held by its unclear field: ${hold.field}`
    case 'none':
      return UNEXPLAINED_HOLD
    case 'depends':
      return `its dependency #${hold.depends} is not merged yet`
    case 'dropped-depends':
      return `its dependency #${hold.dropped} is dropped, so it never launches until its depends are amended or it is dropped`
  }
}

export function unexplainedStall(line: string): boolean {
  return line.endsWith(UNEXPLAINED_HOLD)
}

export interface StartableCard {
  cardId: number
  admittedTs: string
  hold: StartableHold
}

function openPrNumbers(db: DatabaseSync): Map<number, number> {
  return new Map(openCardPrs(db).reverse().map(row => [row.card_id!, row.pr]))
}

function outsideTheLanes(lane: string | null, lanes: number): boolean {
  const number = lane === null ? null : chainLaneNumber(lane)
  return number !== null && number > lanes
}

function machineHoldOf(machine: MachineReader): StartableHold | null {
  const held = machine.held()
  return held === null ? null : { kind: 'machine', ...held }
}

function windowHold(life: CardLife): StartableHold {
  const field = unclearField(life.task)
  return field === null ? { kind: 'window' } : { kind: 'unclear', field }
}

function residualHold(life: CardLife, holds: Holds, machine: MachineReader): StartableHold {
  if (holds.launching.has(life.cardId))
    return { kind: 'launching' }
  return machineHoldOf(machine) ?? (machine.free() <= 0 ? { kind: 'slots' } : { kind: 'none' })
}

function holdOf(life: CardLife, holds: Holds, openPrs: ReadonlyMap<number, number>, shared: readonly string[], lanes: number, machine: MachineReader): StartableHold {
  if (life.windowsToWork)
    return windowHold(life)
  const overlapping = holds.holding.find(holder => holder.cardId !== life.cardId && HOLDS.holdsAgainst(holder, life) && conflicting(life.task, holder.task, shared))
  if (overlapping !== undefined) {
    const path = overlappingPath(life.task!, overlapping.task, shared)
    const pr = openPrs.get(overlapping.cardId)
    return pr === undefined ? { kind: 'session', cardId: overlapping.cardId, path } : { kind: 'open-pr', pr, cardId: overlapping.cardId, path }
  }
  if (life.lane === null)
    return residualHold(life, holds, machine)
  if (outsideTheLanes(life.lane, lanes))
    return { kind: 'lane-outside', lane: life.lane, lanes }
  const stalling = (holds.heldByStalls.get(life.lane) ?? []).find(holder => HOLDS.holdsAgainst(holder, life) && heldByStall(life, [holder], shared))
  const keeping = stalling ?? holds.busy.find(holder => holder.lane === life.lane && holder.cardId !== life.cardId && HOLDS.holdsAgainst(holder, life))
  if (keeping !== undefined)
    return { kind: 'lane', cardId: keeping.cardId, lane: life.lane }
  return residualHold(life, holds, machine)
}

export interface HeldExit {
  cardId: number
  startKey: string
  session: string
  exited: string
}

export function waitHeldAtTheExit(db: DatabaseSync, ts: string, actor: string, exit: HeldExit): boolean {
  const hold = cardHoldOf(db, exit.cardId)
  if (hold === null)
    return false
  const detail = `${exit.exited}; ${hold}, so no session continues from it until the hold is released`
  appendEvent(db, { ts, type: CARD_WAITING, actor, cardId: exit.cardId, pr: null, head: null, dedupeKey: `${CARD_WAITING}:${HELD_AT_THE_EXIT}:${exit.startKey}`, payload: { reason: HELD_AT_THE_EXIT, session: exit.session, detail }, legacy: false })
  return true
}

export function startHold(db: DatabaseSync, cardId: number, lanes: number, machine: MachineReader): StartableHold | null {
  const life = withAssignedLanes(db, cardLives(db)).get(cardId)
  if (life !== undefined && outsideTheLanes(life.lane, lanes) && isQueued(life, settledCards(db, cardSet(db, MERGED_CARDS))))
    return { kind: 'lane-outside', lane: life.lane!, lanes }
  return machineHoldOf(machine)
}

export const dependencyReadings = (db: DatabaseSync) => ({ pullRequests: () => prs.all(db), journal: () => legacyHistory(db) })

interface QueuedView {
  queued: CardLife[]
  unsatisfied: ReturnType<typeof unsatisfiedDependencies>
  holds: Holds
  prNumbers: Map<number, number>
}

function queuedView(db: DatabaseSync, treeLive: TreeReader, nowMs: number, withWindowCards = false): QueuedView {
  const lives = withAssignedLanes(db, cardLives(db))
  const merged = cardSet(db, MERGED_CARDS)
  const settled = settledCards(db, merged)
  const openPrs = cardSet(db, OPEN_PR_CARDS)
  const trees = standingTrees(db, treeLive)
  const beating = cardsBeatingLive(db, nowMs)
  const noLongerCandidates = cardSet(db, NO_LONGER_CANDIDATES)
  const falls = fallCounts(db)
  const queued = [...lives.values()]
    .filter(life => !noLongerCandidates.has(life.cardId) && (withWindowCards || !life.windowsToWork) && (falls.get(life.cardId) ?? 0) < FALLS_BEFORE_CUT && isQueued(life, settled) && !heldOutside(life, openPrs, trees, beating) && cardHoldOf(db, life.cardId) === null)
  return { queued, unsatisfied: unsatisfiedDependencies(BUS_CONTRACT, db, dependencyReadings(db)), holds: holdsOf(db, lives, merged, openPrs, beating), prNumbers: openPrNumbers(db) }
}

export function startableCards(db: DatabaseSync, treeLive: TreeReader = existsSync, now: () => number = Date.now, shared: readonly string[] = sharedAppendFiles(), lanes: () => number = repositoryLanes(process.cwd()), machine: MachineReader = machineSessions(isAlive)): StartableCard[] {
  const view = queuedView(db, treeLive, now(), true)
  return view.queued
    .filter(life => view.unsatisfied(life.depends).length === 0)
    .map(life => ({ cardId: life.cardId, admittedTs: life.admittedTs, hold: startableHold(db, life, view, shared, lanes(), machine) }))
}

function startableHold(db: DatabaseSync, life: CardLife, view: QueuedView, shared: readonly string[], lanes: number, machine: MachineReader): StartableHold {
  const hold = holdOf(life, view.holds, view.prNumbers, shared, lanes, machine)
  return hold.kind === 'none' && bodyNotFoldedYet(BUS_CONTRACT, db, life.cardId) ? { kind: 'unfolded' } : hold
}

export interface LaneHeadHold {
  lane: string
  cardId: number
  hold: StartableHold
}

function dependencyHold(life: CardLife, dropped: ReadonlySet<number>, unsatisfied: QueuedView['unsatisfied']): StartableHold | null {
  const droppedParent = life.depends.find(parent => dropped.has(parent))
  if (droppedParent !== undefined)
    return { kind: 'dropped-depends', dropped: droppedParent }
  const open = unsatisfied(life.depends)[0]
  return open === undefined ? null : { kind: 'depends', depends: open }
}

export function laneHeadHolds(db: DatabaseSync, treeLive: TreeReader = existsSync, now: () => number = Date.now, shared: readonly string[] = sharedAppendFiles(), lanes: () => number = repositoryLanes(process.cwd()), machine: MachineReader = machineSessions(isAlive)): LaneHeadHold[] {
  const view = queuedView(db, treeLive, now())
  const dropped = droppedCards(db)
  const laned = view.queued.filter(life => life.lane !== null)
  const heads = new Map<string, CardLife>()
  for (const life of laned.sort(startOrder(laned))) {
    if (!heads.has(life.lane!))
      heads.set(life.lane!, life)
  }
  const laneLimit = lanes()
  return [...heads.values()].map(life => ({ lane: life.lane!, cardId: life.cardId, hold: dependencyHold(life, dropped, view.unsatisfied) ?? holdOf(life, view.holds, view.prNumbers, shared, laneLimit, machine) }))
}

interface RecordedLaneHold {
  id: number
  card: unknown
  hold: unknown
  reason: unknown
}

function recordedLaneHolds(db: DatabaseSync): Map<string, RecordedLaneHold> {
  const latest = new Map<string, RecordedLaneHold>()
  for (const held of new BusRead(db).slice(LANE_HELD, ['lane', 'card', 'hold', 'reason'])) {
    if (typeof held.fields.lane === 'string')
      latest.set(held.fields.lane, { id: held.id, card: held.fields.card ?? null, hold: held.fields.hold ?? null, reason: held.fields.reason ?? null })
  }
  return latest
}

function sameLaneHold(recorded: RecordedLaneHold | undefined, head: LaneHeadHold | undefined): boolean {
  if (recorded === undefined || head === undefined)
    return head === undefined && (recorded === undefined || recorded.card === null)
  return recorded.card === head.cardId && recorded.hold === head.hold.kind && (head.hold.kind === 'machine' || recorded.reason === holdReason(head.hold))
}

export function recordLaneHolds(db: DatabaseSync, heads: readonly LaneHeadHold[], stamp: LaunchCatch['stamp']): void {
  const recorded = recordedLaneHolds(db)
  const current = new Map(heads.map(head => [head.lane, head]))
  for (const lane of new Set([...recorded.keys(), ...current.keys()])) {
    const [before, head] = [recorded.get(lane), current.get(lane)]
    if (sameLaneHold(before, head))
      continue
    const payload = head === undefined ? { lane, card: null, hold: null, reason: null } : { lane, card: head.cardId, hold: head.hold.kind, reason: holdReason(head.hold) }
    appendEvent(db, { ts: stamp.ts, type: LANE_HELD, actor: stamp.actor, cardId: head?.cardId ?? null, pr: null, head: null, dedupeKey: `${LANE_HELD}:${lane}:${before?.id ?? 0}`, payload, legacy: false })
  }
}

export interface QuestionReleasedOverlap {
  cardId: number
  stopped: number
  path: string
  waits: string[]
}

function openWaitsOf(db: DatabaseSync, cardId: number): string[] {
  return openOwnerWaits(db).filter(wait => wait.card === cardId).map(wait => wait.id)
}

export function questionReleasedOverlaps(db: DatabaseSync, nowMs: number, shared: readonly string[] = sharedAppendFiles()): QuestionReleasedOverlap[] {
  const lives = cardLives(db)
  const beating = cardsBeatingLive(db, nowMs)
  const settled = settledCards(db, cardSet(db, MERGED_CARDS))
  const released = [...cardSet(db, OPEN_LAUNCHES)].filter(cardId => launchHeldByItsQuestion(db, cardId, beating)).flatMap(cardId => lives.get(cardId) ?? [])
  return released.flatMap(stopped => [...lives.values()]
    .filter(life => life.cardId !== stopped.cardId && isQueued(life, settled) && conflicting(life.task, stopped.task, shared))
    .map(life => ({ cardId: life.cardId, stopped: stopped.cardId, path: overlappingPath(life.task!, stopped.task, shared), waits: openWaitsOf(db, stopped.cardId) })))
}

export function questionReleasedLine(overlap: QuestionReleasedOverlap): string {
  const question = overlap.waits.length === 0 ? 'its question' : `its question ${overlap.waits.join(', ')}`
  return `#${overlap.cardId} overlaps #${overlap.stopped} on ${overlap.path}: #${overlap.stopped} waits on ${question} with no live session, so its queued launch holds none of its touches`
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
  const unsatisfied = unsatisfiedDependencies(BUS_CONTRACT, db, dependencyReadings(db))
  const launching = cardSet(db, OPEN_LAUNCHES)
  const openPrs = cardSet(db, OPEN_PR_CARDS)
  const trees = standingTrees(db, treeLive)
  const beating = cardsBeatingLive(db, now())
  const noLongerCandidates = cardSet(db, NO_LONGER_CANDIDATES)
  const falls = fallCounts(db)
  const { holding, busy: busyCards, heldByStalls } = holdsOf(db, lives, merged, openPrs, beating)
  const busy = [...busyCards]
  const taken = [...holding]
  const chosen: LaunchCandidate[] = []
  const open = [...lives.values()].filter(life => !noLongerCandidates.has(life.cardId))
  if ('stamp' in onOverlap)
    waitOnDroppedDependencies(db, open.filter(life => isQueued(life, settled)), onOverlap.stamp)
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
    if (!isQueued(life, settled) || (life.lane !== null && (outsideTheLanes(life.lane, laneLimit) || busy.some(holder => holder.lane === life.lane && HOLDS.holdsAgainst(holder, life)) || heldByStall(life, (heldByStalls.get(life.lane) ?? []).filter(holder => HOLDS.holdsAgainst(holder, life)), shared))) || unsatisfied(life.depends).length > 0 || heldOutside(life, openPrs, trees, beating) || heldSessionStop(db, life.cardId)?.code === OUTSIDE_TOUCHES)
      continue
    if (bodyNotFoldedYet(BUS_CONTRACT, db, life.cardId))
      continue
    if (overlapsAny(life, taken, shared)) {
      onOverlap(life.cardId, life.generation)
      continue
    }
    if (free <= 0)
      continue
    free -= 1
    const started = holderOf(life, life.task, false)
    busy.push(started)
    taken.push(started)
    chosen.push({ cardId: life.cardId, generation: life.generation, ...continuedTree(life, trees) })
  }
  if ('skipped' in onOverlap)
    logSkips(db, onOverlap.skipped, launching, now(), treeLive, shared, lanes, machine)
  if ('stamp' in onOverlap) {
    const starting = new Set(chosen.map(candidate => candidate.cardId))
    recordLaneHolds(db, laneHeadHolds(db, treeLive, now, shared, lanes, machine).filter(head => !starting.has(head.cardId)), onOverlap.stamp)
  }
  return chosen
}

export function launchTasks(db: DatabaseSync, onOverlap?: OverlapCatch): QueuedTask[] {
  return launchCandidates(db, undefined, undefined, onOverlap).map(({ cardId, generation }) => ({ queue: 'launch', cardId, generation }))
}

export const LAUNCH_SOURCE: QueueSource = { queue: 'launch', enqueue: db => launchTasks(db) }

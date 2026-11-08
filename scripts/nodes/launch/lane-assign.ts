import type { DatabaseSync } from 'node:sqlite'
import type { ParkedTask, Priority } from '../../../src/card/parking.js'
import type { ShiftTask } from '../../../src/card/task-file.js'
import type { Assignment } from '../../core/bus-readings.js'
import type { LaunchCatch } from './launch-candidates.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseParkingFile, PRIORITIES, WINDOW_WHO } from '../../../src/card/parking.js'
import { ATTACH_RECORD_FILE } from '../../../src/commands/attach/record.js'
import { DEFAULT_LANES, isLaneCount, MANIFEST_FILE } from '../../../src/manifest.js'
import { currentLane, latestAssignment, OPEN_WAIT, OWNER_WAITS } from '../../core/bus-readings.js'
import { DEFERRED_CARD, RUNNING_CARD } from '../../core/card-automaton.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_DROPPED, LANE_ASSIGNED, LANE_OVERLAP, POLICY_DENIED } from '../../core/events.js'
import { prOf } from '../../core/identifiers.js'
import { taskConflicts } from './overlap.js'
import { sharedAppendFiles } from './shared-files.js'

export const DEFAULT_LANE_COUNT = DEFAULT_LANES
export const LANE_COUNT_FIELD = 'lanes'

const CHAIN_LANE = /^lane-(\d+)$/

const ENDED_STATES = ['merged', 'closed', 'dropped']

const NOT_STARTED_STATES = [null, 'queued']

export const STALLED = 'stalled'

export const OWNER_MERGE = 'owner_merge'

const STALLED_PRS = `
  SELECT prs.card_id, prs.pr, prs.head FROM prs
  WHERE prs.state = 'open' AND prs.card_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM tasks AS moving WHERE moving.card_id = prs.card_id AND moving.state IN ('queued', 'leased'))
    AND (
      EXISTS (SELECT 1 FROM ${OWNER_WAITS} AS wait WHERE wait.need = 'merge' AND wait.state = '${OPEN_WAIT}' AND wait.pr = prs.pr)
      OR EXISTS (SELECT 1 FROM tasks AS merge WHERE merge.queue = 'merge' AND merge.pr = prs.pr AND merge.head = prs.head AND merge.state = 'withdrawn')
    )
  ORDER BY prs.card_id
`

const OWNER_MERGE_HOLDERS = `
  SELECT DISTINCT prs.card_id FROM prs
  WHERE prs.state = 'open' AND prs.card_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM ${OWNER_WAITS} AS wait WHERE wait.need = 'merge' AND wait.state = '${OPEN_WAIT}' AND wait.pr = prs.pr)
`

const LATEST_MERGE_DENIAL = `
  SELECT payload FROM events
  WHERE legacy = 0 AND type = '${POLICY_DENIED}' AND card_id = ? AND pr = ? AND json_valid(payload) AND json_extract(payload, '$.command') = 'merge'
  ORDER BY id DESC LIMIT 1
`

const ADMITTED_CARDS = `
  SELECT admitted.card_id, max(admitted.id) AS admission, cards.state FROM events AS admitted
  LEFT JOIN cards ON cards.card_id = admitted.card_id
  WHERE admitted.legacy = 0 AND admitted.type = '${CARD_ADMITTED}' AND admitted.card_id IS NOT NULL
  GROUP BY admitted.card_id
  HAVING coalesce((SELECT max(dropped.id) FROM events AS dropped WHERE dropped.legacy = 0 AND dropped.type = '${CARD_DROPPED}' AND dropped.card_id = admitted.card_id), 0) < max(admitted.id)
  ORDER BY admitted.card_id
`

const TEXT_ADMISSIONS = `
  SELECT id, payload FROM events
  WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND card_id = ? AND json_valid(payload) AND json_type(payload, '$.text') = 'text'
  ORDER BY id DESC LIMIT 2
`

const OPEN_PR_CARDS = `SELECT DISTINCT card_id FROM prs WHERE state = 'open' AND card_id IS NOT NULL`

const LATEST_ADMISSION = `SELECT max(id) AS id FROM events WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND card_id = ?`

export type LaneReason = 'chain' | 'kept' | 'free' | 'least-loaded' | 'moved' | 'reflowed'

export interface LaneCard {
  cardId: number
  depends: readonly number[]
  task: ShiftTask | null
  deferred?: boolean
}

export interface LiveLane extends LaneCard {
  lane: string
}

export interface LaneChoice {
  lane: string
  reason: LaneReason
  after: number[]
}

export function chainLaneName(number: number): string {
  return `lane-${number}`
}

export function chainLaneNumber(lane: string): number | null {
  const number = CHAIN_LANE.exec(lane)?.[1]
  return number === undefined ? null : Number(number)
}

const LANE_COUNT_RECORDS = [MANIFEST_FILE, ATTACH_RECORD_FILE]

function recordedLaneCount(file: string): number | null {
  if (!existsSync(file))
    return null
  try {
    const value = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null)?.[LANE_COUNT_FIELD]
    return isLaneCount(value) ? value : null
  }
  catch {
    return null
  }
}

export function laneCount(root: string): number {
  for (const record of LANE_COUNT_RECORDS) {
    const count = recordedLaneCount(path.join(root, record))
    if (count !== null)
      return count
  }
  return DEFAULT_LANE_COUNT
}

export function mainCheckoutOf(cwd: string): string {
  try {
    return path.dirname(execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim())
  }
  catch {
    return cwd
  }
}

export function repositoryLanes(cwd: string): () => number {
  const root = mainCheckoutOf(cwd)
  return () => laneCount(root)
}

export interface Stall {
  cardId: number
  pr: number
  head: string | null
  cause: string
  detail: string
}

interface StalledPr { card_id: number, pr: number, head: string | null }

function denialOf(db: DatabaseSync, row: StalledPr): Pick<Stall, 'cause' | 'detail'> {
  const denial = db.prepare(LATEST_MERGE_DENIAL).get(row.card_id, row.pr) as { payload: string } | undefined
  const payload = denial === undefined ? {} : parsed(denial.payload)
  const cause = payload.rule ?? payload.reason
  return {
    cause: typeof cause === 'string' ? cause : OWNER_MERGE,
    detail: typeof payload.detail === 'string' ? payload.detail : `PR #${row.pr} waits for the owner to merge it`,
  }
}

export function stalledCards(db: DatabaseSync): Stall[] {
  return (db.prepare(STALLED_PRS).all() as unknown as StalledPr[]).map(row => ({ cardId: row.card_id, pr: row.pr, head: row.head, ...denialOf(db, row) }))
}

export function raiseStallAlarms(db: DatabaseSync, stalls: readonly Stall[], ts: string, actor: string): number {
  return stalls.filter(stall => appendEvent(db, { ts, type: BOARD_ALARM, actor, cardId: stall.cardId, pr: stall.pr, head: stall.head, dedupeKey: `${BOARD_ALARM}:${STALLED}:${stall.cardId}:${stall.pr}:${stall.head}:${stall.cause}`, payload: { reason: STALLED, cause: stall.cause, detail: `card #${stall.cardId} cannot move by itself: ${stall.detail}` }, legacy: false })).length
}

export function heldByStall(card: LaneCard, holders: readonly LaneCard[], shared: readonly string[] = []): boolean {
  return holders.some(holder => card.task === null || holder.task === null || chainedTo(card, holder, shared))
}

const REBUILT_ON_REBASE = new Set(['package.json', 'pnpm-lock.yaml'])

function laneTouches(task: ShiftTask): ShiftTask {
  return { ...task, touches: task.touches.filter(entry => !REBUILT_ON_REBASE.has(path.posix.basename(entry))) }
}

function overlaps(a: ShiftTask | null, b: ShiftTask | null, shared: readonly string[]): boolean {
  return a !== null && b !== null && taskConflicts([laneTouches(a), laneTouches(b)], shared).length > 0
}

function dependsOnDeferred(card: LaneCard, other: LaneCard): boolean {
  return other.deferred === true && card.depends.includes(other.cardId)
}

function chainedTo(card: LaneCard, other: LaneCard, shared: readonly string[]): boolean {
  if (card.deferred === true || other.deferred === true)
    return dependsOnDeferred(card, other) || dependsOnDeferred(other, card)
  return card.depends.includes(other.cardId) || other.depends.includes(card.cardId) || overlaps(card.task, other.task, shared)
}

function byNumber(a: string, b: string): number {
  return (chainLaneNumber(a) ?? Number.MAX_SAFE_INTEGER) - (chainLaneNumber(b) ?? Number.MAX_SAFE_INTEGER)
}

function withinCount(lane: string, count: number): boolean {
  const number = chainLaneNumber(lane)
  return number !== null && number <= count
}

function laneNumbers(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1)
}

function chainChoice(chained: readonly LiveLane[], current: string | null): LaneChoice {
  const lanes = [...new Set(chained.map(other => other.lane))].sort(byNumber)
  const lane = current !== null && lanes.includes(current) ? current : lanes[0]!
  return { lane, reason: 'chain', after: chained.filter(other => other.lane === lane).map(other => other.cardId) }
}

function binding(card: LaneCard, chained: readonly LiveLane[], others: readonly LiveLane[], shared: readonly string[]): LiveLane[] {
  const overlapping = chained.filter(other => overlaps(card.task, other.task, shared))
  if (overlapping.length > 0)
    return overlapping
  return chained.filter(other => others.every(each => each.lane !== other.lane || chainedTo(card, each, shared)))
}

function leastLoaded(load: ReadonlyMap<number, number>, numbers: readonly number[]): number {
  return numbers.reduce((best, number) => load.get(number)! < load.get(best)! ? number : best)
}

function lanesClearOfOwnerMerge(count: number, occupants: readonly LiveLane[], waitingOnOwner: ReadonlySet<number>): number[] {
  const held = new Set(occupants.filter(other => waitingOnOwner.has(other.cardId)).map(other => other.lane))
  return laneNumbers(count).filter(number => !held.has(chainLaneName(number)))
}

export function ownerMergeHolders(db: DatabaseSync): Set<number> {
  return new Set((db.prepare(OWNER_MERGE_HOLDERS).all() as { card_id: number }[]).map(row => row.card_id))
}

export function chooseLane(card: LaneCard, live: readonly LiveLane[], count: number, current: string | null = null, occupying: readonly LiveLane[] = live, waitingOnOwner: ReadonlySet<number> = new Set(), shared: readonly string[] = []): LaneChoice {
  const others = live.filter(other => other.cardId !== card.cardId && (other.deferred !== true || dependsOnDeferred(card, other)))
  const occupants = occupying.filter(other => other.cardId !== card.cardId && other.deferred !== true)
  const chained = others.filter(other => withinCount(other.lane, count) && chainedTo(card, other, shared))
  const bound = binding(card, chained, others, shared)
  if (bound.length > 0)
    return chainChoice(bound, current)
  if (current !== null && withinCount(current, count))
    return { lane: current, reason: 'kept', after: [] }
  const load = new Map(laneNumbers(count).map(number => [number, occupants.filter(other => other.lane === chainLaneName(number)).length]))
  const free = laneNumbers(count).find(number => load.get(number) === 0)
  if (free !== undefined)
    return { lane: chainLaneName(free), reason: 'free', after: [] }
  if (chained.length > 0)
    return chainChoice(chained, current)
  const clear = lanesClearOfOwnerMerge(count, occupants, waitingOnOwner)
  const least = leastLoaded(load, clear.length > 0 ? clear : laneNumbers(count))
  return { lane: chainLaneName(least), reason: 'least-loaded', after: [] }
}

interface AdmissionRow { id: number, payload: string }

function parsed(payload: string): Record<string, unknown> {
  try {
    const value = JSON.parse(payload) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function parkedOf(cardId: number, payload: Record<string, unknown>): ParkedTask | null {
  if (typeof payload.text !== 'string')
    return null
  const card = parseParkingFile(`${cardId}.md`, payload.text)
  return card.kind === 'parked' ? card.parked : null
}

function taskOf(cardId: number, payload: Record<string, unknown>): ShiftTask | null {
  return parkedOf(cardId, payload)?.task ?? null
}

function dependsOf(payload: Record<string, unknown>): number[] {
  return Array.isArray(payload.depends) ? payload.depends.map(prOf).filter(each => each !== null) : []
}

function textAdmissions(db: DatabaseSync, cardId: number): AdmissionRow[] {
  return db.prepare(TEXT_ADMISSIONS).all(cardId) as unknown as AdmissionRow[]
}

function latestPayload(db: DatabaseSync, cardId: number): Record<string, unknown> {
  const latest = textAdmissions(db, cardId)[0]
  return latest === undefined ? {} : parsed(latest.payload)
}

function laneCardOf(db: DatabaseSync, cardId: number): LaneCard {
  const payload = latestPayload(db, cardId)
  return { cardId, depends: dependsOf(payload), task: taskOf(cardId, payload) }
}

function priorityOf(db: DatabaseSync, cardId: number): Priority | null {
  return parkedOf(cardId, latestPayload(db, cardId))?.priority ?? null
}

type Size = ShiftTask['card']['size']

export interface SizedTask {
  card: { size: Size }
}

export interface OrderedCard {
  cardId: number
  depends: readonly number[]
  priority: Priority | null
  task?: SizedTask | null
}

const SIZE_WEIGHTS: Record<Size, number> = { XS: 1, S: 2, M: 3, L: 5 }

const UNSIZED_WEIGHT = SIZE_WEIGHTS.XS

function dependentsOf(cards: readonly OrderedCard[]): Map<number, number[]> {
  const dependents = new Map<number, number[]>()
  for (const card of cards) {
    for (const parent of card.depends)
      dependents.set(parent, [...(dependents.get(parent) ?? []), card.cardId])
  }
  return dependents
}

function blockedBy(cardId: number, dependents: ReadonlyMap<number, readonly number[]>): Set<number> {
  const seen = new Set<number>()
  const pending = [...(dependents.get(cardId) ?? [])]
  while (pending.length > 0) {
    const next = pending.pop()!
    if (next === cardId || seen.has(next))
      continue
    seen.add(next)
    pending.push(...(dependents.get(next) ?? []))
  }
  return seen
}

function priorityRank(priority: Priority | null): number {
  return priority === null ? PRIORITIES.length : PRIORITIES.indexOf(priority)
}

function weightOf(card: OrderedCard): number {
  const size = card.task?.card.size
  return size === undefined ? UNSIZED_WEIGHT : SIZE_WEIGHTS[size]
}

function chainBehind(cardId: number, dependents: ReadonlyMap<number, readonly number[]>, weights: ReadonlyMap<number, number>, onPath: Set<number>, memo: Map<number, number>): number {
  const known = memo.get(cardId)
  if (known !== undefined)
    return known
  onPath.add(cardId)
  const longest = Math.max(0, ...(dependents.get(cardId) ?? []).filter(next => !onPath.has(next)).map(next => weights.get(next)! + chainBehind(next, dependents, weights, onPath, memo)))
  onPath.delete(cardId)
  memo.set(cardId, longest)
  return longest
}

export function startOrder(cards: readonly OrderedCard[]): (a: OrderedCard, b: OrderedCard) => number {
  const dependents = dependentsOf(cards)
  const weights = new Map(cards.map(card => [card.cardId, weightOf(card)]))
  const ownRanks = new Map(cards.map(card => [card.cardId, priorityRank(card.priority)]))
  const blocked = new Map(cards.map(card => [card.cardId, [...blockedBy(card.cardId, dependents)]]))
  const ranks = new Map(cards.map(card => [card.cardId, Math.min(ownRanks.get(card.cardId)!, ...blocked.get(card.cardId)!.map(each => ownRanks.get(each)!))]))
  const chains = new Map(cards.map(card => [card.cardId, chainBehind(card.cardId, dependents, weights, new Set(), new Map())]))
  return (a, b) => ranks.get(a.cardId)! - ranks.get(b.cardId)! || chains.get(b.cardId)! - chains.get(a.cardId)! || blocked.get(b.cardId)!.length - blocked.get(a.cardId)!.length || a.cardId - b.cardId
}

export { currentLane }

interface AdmittedRow { card_id: number, admission: number, state: string | null }

function liveRows(db: DatabaseSync): AdmittedRow[] {
  return (db.prepare(ADMITTED_CARDS).all() as unknown as AdmittedRow[]).filter(row => row.state === null || !ENDED_STATES.includes(row.state))
}

function deferredRow(db: DatabaseSync, row: AdmittedRow): boolean {
  return notStarted(row) && parkedOf(row.card_id, latestPayload(db, row.card_id))?.who === WINDOW_WHO
}

export function liveLanes(db: DatabaseSync): LiveLane[] {
  return liveRows(db).flatMap((row) => {
    const lane = row.state === DEFERRED_CARD ? null : currentLane(db, row.card_id)
    return lane === null ? [] : [{ ...laneCardOf(db, row.card_id), lane, deferred: deferredRow(db, row) }]
  })
}

function assign(db: DatabaseSync, cardId: number, admission: number, choice: LaneChoice, count: number, ts: string, actor: string): boolean {
  const previous = latestAssignment(db, cardId)?.id ?? 0
  return appendEvent(db, { ts, type: LANE_ASSIGNED, actor, cardId, pr: null, head: null, dedupeKey: `${LANE_ASSIGNED}:${admission}:${previous}`, payload: { ...choice, lanes: count, admission }, legacy: false })
}

function afterOf(assignment: Assignment): number[] {
  const after = assignment.after === null ? [] : JSON.parse(assignment.after) as unknown
  return Array.isArray(after) ? after.filter(each => typeof each === 'number') : []
}

function notStarted(row: AdmittedRow): boolean {
  return NOT_STARTED_STATES.includes(row.state)
}

function chainedOnlyThroughEnded(db: DatabaseSync, row: AdmittedRow, rows: readonly AdmittedRow[]): boolean {
  const assignment = latestAssignment(db, row.card_id)
  if (!notStarted(row) || assignment === undefined || assignment.reason !== 'chain')
    return false
  const live = new Set(rows.map(each => each.card_id))
  return afterOf(assignment).every(parent => !live.has(parent))
}

function keptWhere(db: DatabaseSync, cardId: number, current: string | null, count: number): boolean {
  return current !== null && (withinCount(current, count) || latestAssignment(db, cardId)?.reason === 'moved')
}

function releasedChoice(db: DatabaseSync, card: LaneCard, rows: readonly AdmittedRow[], count: number, shared: readonly string[]): LaneChoice {
  const started = new Set(rows.filter(row => !notStarted(row)).map(row => row.card_id))
  const live = liveLanes(db)
  const binders = live.filter(other => started.has(other.cardId) || card.depends.includes(other.cardId))
  return chooseLane(card, binders, count, null, live, ownerMergeHolders(db), shared)
}

export function assignMovedLane(db: DatabaseSync, cardId: number, lane: string, count: number, ts: string, actor: string): boolean {
  const admission = (db.prepare(LATEST_ADMISSION).get(cardId) as { id: number | null }).id
  return admission !== null && assign(db, cardId, Number(admission), { lane, reason: 'moved', after: [] }, count, ts, actor)
}

export function layOutLanes(db: DatabaseSync, count: number, ts: string, actor: string, shared: readonly string[]): number {
  let assigned = 0
  const rows = liveRows(db)
  for (const row of rows.filter(each => each.state !== DEFERRED_CARD)) {
    const current = currentLane(db, row.card_id)
    const released = current !== null && chainedOnlyThroughEnded(db, row, rows)
    if (keptWhere(db, row.card_id, current, count) && !released)
      continue
    const card = laneCardOf(db, row.card_id)
    const live = liveLanes(db)
    const choice = released ? releasedChoice(db, card, rows, count, shared) : chooseLane(card, live, count, null, live, ownerMergeHolders(db), shared)
    if (assign(db, row.card_id, Number(row.admission), choice, count, ts, actor))
      assigned += 1
  }
  return assigned + reflowLanes(db, count, ts, actor, shared)
}

interface ReflowCard extends LiveLane, OrderedCard {
  task: ShiftTask | null
  admission: number
  waiting: boolean
}

function reflowCards(db: DatabaseSync, rows: readonly AdmittedRow[]): ReflowCard[] {
  const byCard = new Map(rows.map(row => [row.card_id, row]))
  return liveLanes(db).map((card) => {
    const row = byCard.get(card.cardId)!
    return { ...card, priority: priorityOf(db, card.cardId), admission: Number(row.admission), waiting: notStarted(row) }
  })
}

function touchHolders(cards: readonly ReflowCard[], rows: readonly AdmittedRow[], openPrs: ReadonlySet<number>): ReflowCard[] {
  const running = new Set(rows.filter(row => row.state === RUNNING_CARD).map(row => row.card_id))
  return cards.filter(card => running.has(card.cardId) || openPrs.has(card.cardId))
}

function closure(seed: readonly ReflowCard[], candidates: readonly ReflowCard[], joins: (candidate: ReflowCard, member: ReflowCard) => boolean): ReflowCard[] {
  const closed = [...seed]
  for (let index = 0; index < closed.length; index += 1) {
    for (const candidate of candidates) {
      if (!closed.includes(candidate) && joins(candidate, closed[index]!))
        closed.push(candidate)
    }
  }
  return closed
}

function chainIn(card: ReflowCard, cards: readonly ReflowCard[], shared: readonly string[]): ReflowCard[] {
  return closure([card], cards.filter(other => other.lane === card.lane), (other, member) => chainedTo(member, other, shared))
}

function notReadyIn(chain: readonly ReflowCard[], cards: readonly ReflowCard[], holders: readonly ReflowCard[], shared: readonly string[]): ReflowCard[] {
  const members = new Set(chain.map(card => card.cardId))
  const live = new Set(cards.map(card => card.cardId))
  const waitsOutside = chain.filter(card => !card.waiting
    || card.task === null
    || holders.some(holder => holder.cardId === card.cardId || overlaps(card.task, holder.task, shared))
    || card.depends.some(parent => !members.has(parent) && live.has(parent)))
  return closure(waitsOutside, chain, (other, member) => other.depends.includes(member.cardId))
}

function staysWith(db: DatabaseSync, ready: readonly ReflowCard[], notReady: readonly ReflowCard[], shared: readonly string[]): ReflowCard[] {
  const anchored = ready.filter(card => latestAssignment(db, card.cardId)?.reason === 'moved' || notReady.some(other => other.depends.includes(card.cardId)))
  return closure(anchored, ready, (other, member) => chainedTo(member, other, shared))
}

function movableParts(db: DatabaseSync, chain: readonly ReflowCard[], cards: readonly ReflowCard[], holders: readonly ReflowCard[], shared: readonly string[]): ReflowCard[][] {
  const notReady = notReadyIn(chain, cards, holders, shared)
  const ready = chain.filter(card => !notReady.includes(card))
  const staying = staysWith(db, ready, notReady, shared)
  const parts: ReflowCard[][] = []
  const moving = ready.filter(card => !staying.includes(card))
  for (const card of [...moving].sort(startOrder(cards))) {
    if (!parts.some(part => part.includes(card)))
      parts.push(chainIn(card, moving, shared))
  }
  return parts.filter(part => part.some(member => member.deferred !== true) && cards.some(other => other.lane === part[0]!.lane && !part.includes(other) && other.deferred !== true))
}

function freeToLeaveItsLane(part: readonly ReflowCard[], cards: readonly ReflowCard[], shared: readonly string[]): boolean {
  const live = new Set(cards.map(card => card.cardId))
  const members = new Set(part.map(member => member.cardId))
  return part.every(member => member.depends.every(parent => !live.has(parent)))
    && !cards.some(other => other.lane === part[0]!.lane && other.depends.some(parent => members.has(parent)))
    && !cards.some(other => !other.waiting && part.some(member => overlaps(member.task, other.task, shared)))
}

function waitingIn(lane: string, cards: readonly ReflowCard[]): number {
  return cards.filter(card => card.lane === lane && card.waiting && card.deferred !== true).length
}

function roomierLane(part: readonly ReflowCard[], cards: readonly ReflowCard[], count: number, waitingOnOwner: ReadonlySet<number>, shared: readonly string[]): string | null {
  if (!freeToLeaveItsLane(part, cards, shared))
    return null
  const own = part[0]!.lane
  const occupants = cards.filter(card => card.deferred !== true)
  const open = lanesClearOfOwnerMerge(count, occupants, waitingOnOwner).filter((number) => {
    const lane = chainLaneName(number)
    return lane !== own && !occupants.some(other => other.lane === lane && part.some(member => overlaps(member.task, other.task, shared)))
  })
  if (open.length === 0)
    return null
  const load = new Map(open.map(number => [number, waitingIn(chainLaneName(number), cards)]))
  const least = leastLoaded(load, open)
  return waitingIn(own, cards) - load.get(least)! > part.length ? chainLaneName(least) : null
}

function reflowLanes(db: DatabaseSync, count: number, ts: string, actor: string, shared: readonly string[]): number {
  const rows = liveRows(db)
  const cards = reflowCards(db, rows)
  const occupied = new Set(cards.filter(card => card.deferred !== true).map(card => card.lane))
  const empty = laneNumbers(count).map(chainLaneName).filter(lane => !occupied.has(lane))
  const holders = touchHolders(cards, rows, cardIds(db, OPEN_PR_CARDS))
  const waitingOnOwner = ownerMergeHolders(db)
  const seen = new Set<number>()
  let moved = 0
  for (const card of [...cards].sort(startOrder(cards))) {
    if (seen.has(card.cardId))
      continue
    const chain = chainIn(card, cards, shared)
    chain.forEach(member => seen.add(member.cardId))
    for (const part of movableParts(db, chain, cards, holders, shared)) {
      const lane = empty.shift() ?? roomierLane(part, cards, count, waitingOnOwner, shared)
      if (lane === null)
        continue
      for (const member of part) {
        member.lane = lane
        if (assign(db, member.cardId, member.admission, { lane, reason: 'reflowed', after: [] }, count, ts, actor))
          moved += 1
      }
    }
  }
  return moved
}

function cardIds(db: DatabaseSync, query: string): Set<number> {
  return new Set((db.prepare(query).all() as { card_id: number }[]).map(row => row.card_id))
}

export class SkipLog {
  private readonly lastReason = new Map<number, string>()

  constructor(private readonly write: (line: string) => void) {}

  skipped(cardId: number, reason: string): void {
    if (this.lastReason.get(cardId) === reason)
      return
    this.lastReason.set(cardId, reason)
    this.write(`skip #${cardId}: ${reason}`)
  }
}

export const LAUNCH_LOG_PREFIX = '[bus:launch] '
const LAUNCH_SKIPS = new SkipLog(line => console.log(`${LAUNCH_LOG_PREFIX}${line}`))

export function laneOverlapRecorder(db: DatabaseSync, ts: string, actor: string): LaunchCatch {
  const recorder = (cardId: number, generation: string): void => {
    appendEvent(db, { ts, type: LANE_OVERLAP, actor, cardId, pr: null, head: null, dedupeKey: `${LANE_OVERLAP}:${generation}`, payload: { lane: currentLane(db, cardId), generation }, legacy: false })
  }
  return Object.assign(recorder, { skipped: (cardId: number, reason: string) => LAUNCH_SKIPS.skipped(cardId, reason) })
}

function touchesOf(row: AdmissionRow | undefined, cardId: number): string[] | null {
  const task = row === undefined ? null : taskOf(cardId, parsed(row.payload))
  return task === null ? null : [...task.touches].sort()
}

export function touchesChanged(db: DatabaseSync, cardId: number): boolean {
  const [latest, previous] = textAdmissions(db, cardId)
  return previous !== undefined && JSON.stringify(touchesOf(latest, cardId)) !== JSON.stringify(touchesOf(previous, cardId))
}

export function relayAmended(db: DatabaseSync, cardId: number, count: number, ts: string, actor: string, shared: readonly string[]): boolean {
  const current = currentLane(db, cardId)
  const latest = textAdmissions(db, cardId)[0]
  if (current === null || latest === undefined || !touchesChanged(db, cardId))
    return false
  const live = liveLanes(db)
  const choice = chooseLane(laneCardOf(db, cardId), live, count, current, live, ownerMergeHolders(db), shared)
  return choice.lane !== current && assign(db, cardId, Number(latest.id), choice, count, ts, actor)
}

function relayOne(db: DatabaseSync, row: AdmittedRow, stalled: ReadonlySet<number>, count: number, ts: string, actor: string, shared: readonly string[]): boolean {
  const current = currentLane(db, row.card_id)
  if (!NOT_STARTED_STATES.includes(row.state))
    return false
  const card = laneCardOf(db, row.card_id)
  const live = liveLanes(db)
  const holders = live.filter(other => other.lane === current && stalled.has(other.cardId))
  const moving = live.filter(other => !stalled.has(other.cardId))
  if (holders.length === 0 || heldByStall(card, holders, shared) || !moving.some(other => other.lane === current && other.cardId !== card.cardId))
    return false
  const choice = chooseLane(card, moving, count, null, moving, new Set(), shared)
  return choice.reason === 'free' && choice.lane !== current && assign(db, row.card_id, Number(row.admission), choice, count, ts, actor)
}

export function relayBehindStalls(db: DatabaseSync, stalls: readonly Stall[], count: number, ts: string, actor: string, shared: readonly string[]): number {
  const stalled = new Set(stalls.map(stall => stall.cardId))
  return stalled.size === 0 ? 0 : liveRows(db).filter(row => relayOne(db, row, stalled, count, ts, actor, shared)).length
}

export function layLanes(db: DatabaseSync, count: number, ts: string, actor: string, amended: number | null = null, shared: readonly string[] = sharedAppendFiles()): number {
  const moved = amended !== null && relayAmended(db, amended, count, ts, actor, shared) ? 1 : 0
  const laid = moved + layOutLanes(db, count, ts, actor, shared)
  const stalls = stalledCards(db)
  raiseStallAlarms(db, stalls, ts, actor)
  return laid + relayBehindStalls(db, stalls, count, ts, actor, shared)
}

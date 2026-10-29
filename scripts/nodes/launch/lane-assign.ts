import type { DatabaseSync } from 'node:sqlite'
import type { ShiftTask } from '../../../src/card/task-file.js'
import type { OverlapCatch } from './launch-candidates.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseParkingFile } from '../../../src/card/parking.js'
import { ATTACH_RECORD_FILE } from '../../../src/commands/attach/record.js'
import { DEFAULT_LANES, isLaneCount, MANIFEST_FILE } from '../../../src/manifest.js'
import { appendEvent, OPEN_WAIT, OWNER_WAITS } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, LANE_ASSIGNED, LANE_OVERLAP, MERGE_DONE, POLICY_DENIED } from '../../core/events.js'
import { prOf } from '../../core/identifiers.js'
import { taskConflicts } from './overlap.js'

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

const LATEST_ASSIGNMENT = `SELECT id, json_extract(payload, '$.lane') AS lane FROM events WHERE legacy = 0 AND type = '${LANE_ASSIGNED}' AND card_id = ? ORDER BY id DESC LIMIT 1`

const LATEST_END = `SELECT max(id) AS id FROM events WHERE legacy = 0 AND card_id = ? AND type IN ('${CARD_DROPPED}', '${CARD_CLOSED}', '${MERGE_DONE}')`

export type LaneReason = 'chain' | 'kept' | 'free' | 'least-loaded'

export interface LaneCard {
  cardId: number
  depends: readonly number[]
  task: ShiftTask | null
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

export function heldByStall(card: LaneCard, holders: readonly LaneCard[]): boolean {
  return holders.some(holder => card.task === null || holder.task === null || chainedTo(card, holder))
}

function overlaps(a: ShiftTask | null, b: ShiftTask | null): boolean {
  return a !== null && b !== null && taskConflicts([a, b]).length > 0
}

function chainedTo(card: LaneCard, other: LaneCard): boolean {
  return card.depends.includes(other.cardId) || other.depends.includes(card.cardId) || overlaps(card.task, other.task)
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

function binding(card: LaneCard, chained: readonly LiveLane[], others: readonly LiveLane[]): LiveLane[] {
  const overlapping = chained.filter(other => overlaps(card.task, other.task))
  if (overlapping.length > 0)
    return overlapping
  return chained.filter(other => others.every(each => each.lane !== other.lane || chainedTo(card, each)))
}

export function chooseLane(card: LaneCard, live: readonly LiveLane[], count: number, current: string | null = null): LaneChoice {
  const others = live.filter(other => other.cardId !== card.cardId)
  const chained = others.filter(other => withinCount(other.lane, count) && chainedTo(card, other))
  const bound = binding(card, chained, others)
  if (bound.length > 0)
    return chainChoice(bound, current)
  if (current !== null && withinCount(current, count))
    return { lane: current, reason: 'kept', after: [] }
  const load = new Map(laneNumbers(count).map(number => [number, others.filter(other => other.lane === chainLaneName(number)).length]))
  const free = laneNumbers(count).find(number => load.get(number) === 0)
  if (free !== undefined)
    return { lane: chainLaneName(free), reason: 'free', after: [] }
  if (chained.length > 0)
    return chainChoice(chained, current)
  const least = laneNumbers(count).reduce((best, number) => load.get(number)! < load.get(best)! ? number : best)
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

function taskOf(cardId: number, payload: Record<string, unknown>): ShiftTask | null {
  if (typeof payload.text !== 'string')
    return null
  const card = parseParkingFile(`${cardId}.md`, payload.text)
  return card.kind === 'parked' ? card.parked.task : null
}

function dependsOf(payload: Record<string, unknown>): number[] {
  return Array.isArray(payload.depends) ? payload.depends.map(prOf).filter(each => each !== null) : []
}

function textAdmissions(db: DatabaseSync, cardId: number): AdmissionRow[] {
  return db.prepare(TEXT_ADMISSIONS).all(cardId) as unknown as AdmissionRow[]
}

function laneCardOf(db: DatabaseSync, cardId: number): LaneCard {
  const latest = textAdmissions(db, cardId)[0]
  const payload = latest === undefined ? {} : parsed(latest.payload)
  return { cardId, depends: dependsOf(payload), task: taskOf(cardId, payload) }
}

interface Assignment { id: number, lane: unknown }

function latestAssignment(db: DatabaseSync, cardId: number): Assignment | undefined {
  return db.prepare(LATEST_ASSIGNMENT).get(cardId) as Assignment | undefined
}

export function currentLane(db: DatabaseSync, cardId: number): string | null {
  const assigned = latestAssignment(db, cardId)
  if (assigned === undefined || typeof assigned.lane !== 'string')
    return null
  const ended = (db.prepare(LATEST_END).get(cardId) as { id: number | null }).id
  return ended !== null && Number(ended) > Number(assigned.id) ? null : assigned.lane
}

interface AdmittedRow { card_id: number, admission: number, state: string | null }

function liveRows(db: DatabaseSync): AdmittedRow[] {
  return (db.prepare(ADMITTED_CARDS).all() as unknown as AdmittedRow[]).filter(row => row.state === null || !ENDED_STATES.includes(row.state))
}

export function liveLanes(db: DatabaseSync): LiveLane[] {
  return liveRows(db).flatMap((row) => {
    const lane = currentLane(db, row.card_id)
    return lane === null ? [] : [{ ...laneCardOf(db, row.card_id), lane }]
  })
}

function assign(db: DatabaseSync, cardId: number, admission: number, choice: LaneChoice, count: number, ts: string, actor: string): boolean {
  const previous = latestAssignment(db, cardId)?.id ?? 0
  return appendEvent(db, { ts, type: LANE_ASSIGNED, actor, cardId, pr: null, head: null, dedupeKey: `${LANE_ASSIGNED}:${admission}:${previous}`, payload: { ...choice, lanes: count, admission }, legacy: false })
}

export function layOutLanes(db: DatabaseSync, count: number, ts: string, actor: string): number {
  let assigned = 0
  for (const row of liveRows(db)) {
    const current = currentLane(db, row.card_id)
    if (current !== null && withinCount(current, count))
      continue
    if (assign(db, row.card_id, Number(row.admission), chooseLane(laneCardOf(db, row.card_id), liveLanes(db), count), count, ts, actor))
      assigned += 1
  }
  return assigned
}

export function laneOverlapRecorder(db: DatabaseSync, ts: string, actor: string): OverlapCatch {
  return (cardId, generation) => {
    appendEvent(db, { ts, type: LANE_OVERLAP, actor, cardId, pr: null, head: null, dedupeKey: `${LANE_OVERLAP}:${generation}`, payload: { lane: currentLane(db, cardId), generation }, legacy: false })
  }
}

function touchesOf(row: AdmissionRow | undefined, cardId: number): string[] | null {
  const task = row === undefined ? null : taskOf(cardId, parsed(row.payload))
  return task === null ? null : [...task.touches].sort()
}

export function touchesChanged(db: DatabaseSync, cardId: number): boolean {
  const [latest, previous] = textAdmissions(db, cardId)
  return previous !== undefined && JSON.stringify(touchesOf(latest, cardId)) !== JSON.stringify(touchesOf(previous, cardId))
}

export function relayAmended(db: DatabaseSync, cardId: number, count: number, ts: string, actor: string): boolean {
  const current = currentLane(db, cardId)
  const latest = textAdmissions(db, cardId)[0]
  if (current === null || latest === undefined || !touchesChanged(db, cardId))
    return false
  const choice = chooseLane(laneCardOf(db, cardId), liveLanes(db), count, current)
  return choice.lane !== current && assign(db, cardId, Number(latest.id), choice, count, ts, actor)
}

function relayOne(db: DatabaseSync, row: AdmittedRow, stalled: ReadonlySet<number>, count: number, ts: string, actor: string): boolean {
  const current = currentLane(db, row.card_id)
  if (!NOT_STARTED_STATES.includes(row.state))
    return false
  const card = laneCardOf(db, row.card_id)
  const live = liveLanes(db)
  const holders = live.filter(other => other.lane === current && stalled.has(other.cardId))
  const moving = live.filter(other => !stalled.has(other.cardId))
  if (holders.length === 0 || heldByStall(card, holders) || !moving.some(other => other.lane === current && other.cardId !== card.cardId))
    return false
  const choice = chooseLane(card, moving, count)
  return choice.reason === 'free' && choice.lane !== current && assign(db, row.card_id, Number(row.admission), choice, count, ts, actor)
}

export function relayBehindStalls(db: DatabaseSync, stalls: readonly Stall[], count: number, ts: string, actor: string): number {
  const stalled = new Set(stalls.map(stall => stall.cardId))
  return stalled.size === 0 ? 0 : liveRows(db).filter(row => relayOne(db, row, stalled, count, ts, actor)).length
}

export function layLanes(db: DatabaseSync, count: number, ts: string, actor: string, amended: number | null = null): number {
  const moved = amended !== null && relayAmended(db, amended, count, ts, actor) ? 1 : 0
  const laid = moved + layOutLanes(db, count, ts, actor)
  const stalls = stalledCards(db)
  raiseStallAlarms(db, stalls, ts, actor)
  return laid + relayBehindStalls(db, stalls, count, ts, actor)
}

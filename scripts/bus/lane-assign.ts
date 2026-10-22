import type { DatabaseSync } from 'node:sqlite'
import type { ShiftTask } from '../../src/card/task-file.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseParkingFile } from '../../src/card/parking.js'
import { MANIFEST_FILE } from '../../src/manifest.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, LANE_ASSIGNED, MERGE_DONE } from '../core/events.js'
import { taskConflicts } from '../shift/overlap.js'
import { appendEvent } from './db.js'
import { prOf } from './identifiers.js'

export const DEFAULT_LANE_COUNT = 3
export const LANE_COUNT_FIELD = 'lanes'

const CHAIN_LANE = /^lane-(\d+)$/

const ENDED_STATES = ['merged', 'closed', 'dropped']

const ADMITTED_CARDS = `
  SELECT admitted.card_id, max(admitted.id) AS admission, cards.state FROM events AS admitted
  LEFT JOIN cards ON cards.card_id = admitted.card_id
  WHERE admitted.legacy = 0 AND admitted.type = '${CARD_ADMITTED}' AND admitted.card_id IS NOT NULL
  GROUP BY admitted.card_id
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

export function laneCount(root: string): number {
  const file = path.join(root, MANIFEST_FILE)
  if (!existsSync(file))
    return DEFAULT_LANE_COUNT
  try {
    const value = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null)?.[LANE_COUNT_FIELD]
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_LANE_COUNT
  }
  catch {
    return DEFAULT_LANE_COUNT
  }
}

function overlaps(a: ShiftTask | null, b: ShiftTask | null): boolean {
  return a !== null && b !== null && taskConflicts([a, b]).length > 0
}

function chainedTo(card: LaneCard, other: LaneCard): boolean {
  return card.depends.includes(other.cardId) || overlaps(card.task, other.task)
}

function byNumber(a: string, b: string): number {
  return (chainLaneNumber(a) ?? Number.MAX_SAFE_INTEGER) - (chainLaneNumber(b) ?? Number.MAX_SAFE_INTEGER)
}

function laneNumbers(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1)
}

export function chooseLane(card: LaneCard, live: readonly LiveLane[], count: number, current: string | null = null): LaneChoice {
  const others = live.filter(other => other.cardId !== card.cardId)
  const chained = others.filter(other => chainedTo(card, other))
  if (chained.length > 0) {
    const lanes = [...new Set(chained.map(other => other.lane))].sort(byNumber)
    const lane = current !== null && lanes.includes(current) ? current : lanes[0]!
    return { lane, reason: 'chain', after: chained.filter(other => other.lane === lane).map(other => other.cardId) }
  }
  const currentNumber = current === null ? null : chainLaneNumber(current)
  if (current !== null && currentNumber !== null && currentNumber <= count)
    return { lane: current, reason: 'kept', after: [] }
  const load = new Map(laneNumbers(count).map(number => [number, others.filter(other => other.lane === chainLaneName(number)).length]))
  const free = laneNumbers(count).find(number => load.get(number) === 0)
  if (free !== undefined)
    return { lane: chainLaneName(free), reason: 'free', after: [] }
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

export function currentLane(db: DatabaseSync, cardId: number): string | null {
  const assigned = db.prepare(LATEST_ASSIGNMENT).get(cardId) as { id: number, lane: unknown } | undefined
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
  return appendEvent(db, { ts, type: LANE_ASSIGNED, actor, cardId, pr: null, head: null, dedupeKey: `${LANE_ASSIGNED}:${admission}`, payload: { ...choice, lanes: count, admission }, legacy: false })
}

export function layOutLanes(db: DatabaseSync, count: number, ts: string, actor: string): number {
  let assigned = 0
  for (const row of liveRows(db)) {
    if (currentLane(db, row.card_id) !== null)
      continue
    if (assign(db, row.card_id, Number(row.admission), chooseLane(laneCardOf(db, row.card_id), liveLanes(db), count), count, ts, actor))
      assigned += 1
  }
  return assigned
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

export function layLanes(db: DatabaseSync, count: number, ts: string, actor: string, amended: number | null = null): number {
  const moved = amended !== null && relayAmended(db, amended, count, ts, actor) ? 1 : 0
  return moved + layOutLanes(db, count, ts, actor)
}

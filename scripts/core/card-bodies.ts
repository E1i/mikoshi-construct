import type { DatabaseSync } from 'node:sqlite'
import type { ParkedTask } from '../../src/card/parking.js'
import type { CardEvent } from '../../src/commands/intake/index.js'
import type { BusContract, BusEventData } from './bus-contract.js'
import type { StoredEvent } from './stored-event.js'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { parseParkingFile } from '../../src/card/parking.js'
import { textSha } from '../../src/card/text-sha.js'
import { FACTORY_TWIN } from '../../src/card/witness-fields.js'
import { parentsFromCardLines } from '../../src/commands/intake/admit.js'
import { pathsIn, pathsOutside } from '../policy/touch-scope.js'
import { isBackfill } from './backfill-source.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_CONTINUED, CARD_STARTED, FACTORY_MODE, SESSION_HEARTBEAT, SLICE_PARENTS_BACKFILLED } from './events.js'
import { reject } from './stored-event.js'

export const CARD_BODIES = 'card_bodies'
export const FACTORY_MODES = ['window', 'parallel'] as const
export const DEFAULT_MODE: FactoryMode = 'window'
const RETIRED_LANE_KEY = 'lane'

export type FactoryMode = typeof FACTORY_MODES[number]

interface ParsedColumns {
  who: string | null
  priority: string | null
  branch: string | null
  touches: string | null
  creates: string | null
  card_line: string | null
  contour: string | null
  decision: string | null
  depends: string | null
}

const UNPARSED: ParsedColumns = { who: null, priority: null, branch: null, touches: null, creates: null, card_line: null, contour: null, decision: null, depends: null }

function columnsOf(parked: ParkedTask): ParsedColumns {
  const { task } = parked
  return {
    who: parked.who,
    priority: parked.priority,
    branch: task.branch,
    touches: JSON.stringify(task.touches),
    creates: JSON.stringify(parked.creates),
    card_line: task.card.line,
    contour: task.card.contour,
    decision: task.card.decision,
    depends: JSON.stringify(task.card.depends),
  }
}

function payloadOrNull(event: StoredEvent): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(event.payload) as unknown
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

export function payloadObjectOf(event: StoredEvent): Record<string, unknown> {
  return payloadOrNull(event) ?? reject('payload is not a JSON object')
}

export function isFactoryMode(mode: unknown): mode is FactoryMode {
  return typeof mode === 'string' && (FACTORY_MODES as readonly string[]).includes(mode)
}

export function factoryMode(bus: BusContract, db: DatabaseSync): FactoryMode {
  const mode = bus.latest(db, { types: [FACTORY_MODE] })?.data?.mode
  return isFactoryMode(mode) ? mode : DEFAULT_MODE
}

function recordedTextSha(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown> | null
    return typeof parsed?.textSha === 'string' ? parsed.textSha : null
  }
  catch {
    return null
  }
}

function versioned(bus: BusContract, db: DatabaseSync, event: CardEvent): CardEvent {
  if (event.type !== CARD_ADMITTED || typeof event.payload.text !== 'string')
    return event
  const previous = bus.latest(db, { types: [CARD_ADMITTED], card: event.cardId })
  return { ...event, type: CARD_ADMITTED, payload: { ...event.payload, cardVersion: bus.cardVersion.current, prevAdmissionId: previous?.id ?? null, prevTextSha: previous === null ? null : recordedTextSha(previous.payload) } }
}

export function laid(_db: DatabaseSync, event: CardEvent): CardEvent {
  if (event.type !== CARD_ADMITTED || event.payload[RETIRED_LANE_KEY] === undefined)
    return event
  return { ...event, type: CARD_ADMITTED, payload: { ...event.payload, [RETIRED_LANE_KEY]: undefined } }
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null
}

function namesALine(data: BusEventData | null): data is BusEventData {
  return typeof data?.card === 'string' || typeof data?.text === 'string'
}

function carriesAParent(data: BusEventData | null): boolean {
  const parent = data?.parent
  return parent !== null && typeof parent === 'object' && !Array.isArray(parent)
}

interface CardLine {
  card: number
  line: string
}

interface AdmittedCardLine extends CardLine {
  carrying: boolean
}

type TransferredParents = ReturnType<typeof parentsFromCardLines>

function namesASlice(own: CardLine): boolean {
  const alone = parentsFromCardLines([own], [own])
  return Object.keys(alone.cards).length > 0
}

export type Say = (line: string) => void

function sayOnStderr(line: string): void {
  process.stderr.write(`${line}\n`)
}

function latestCardLines(bus: BusContract, db: DatabaseSync): AdmittedCardLine[] {
  return [...bus.perCard(db, { types: [CARD_ADMITTED] })].flatMap(([card, admissions]) => {
    const data = admissions.map(admission => admission.data).filter(namesALine).at(-1)
    if (data === undefined)
      return []
    const line = (present(data.card) ? data.card : data.text) as string
    return [{ card, line, carrying: admissions.some(admission => carriesAParent(admission.data)) }]
  })
}

function admittedCardLines(bus: BusContract, db: DatabaseSync, except: number): CardLine[] {
  return latestCardLines(bus, db).filter(row => row.card !== except)
}

function withSliceParent(bus: BusContract, db: DatabaseSync, event: CardEvent, say: Say): CardEvent {
  const line = event.payload.card
  if (event.type !== CARD_ADMITTED || event.payload.parent !== undefined || typeof line !== 'string')
    return event
  const own = { card: event.cardId, line }
  if (!namesASlice(own))
    return event
  const transfer = parentsFromCardLines([own], [...admittedCardLines(bus, db, event.cardId), own])
  const parent = transfer.cards[String(event.cardId)]
  if (parent === undefined) {
    if (transfer.unread.includes(event.cardId))
      say(`#${event.cardId}: another card carries the same slice name and part; admitted without a parent`)
    return event
  }
  return { ...event, type: CARD_ADMITTED, payload: { ...event.payload, parent } }
}

export function appendCardEvent(bus: BusContract, db: DatabaseSync, actor: string, unversioned: CardEvent, say: Say = sayOnStderr): boolean {
  const event = withSliceParent(bus, db, versioned(bus, db, unversioned), say)
  return bus.appendEvent(db, { ts: event.ts, type: event.type, actor, cardId: event.cardId, pr: null, head: null, dedupeKey: event.dedupeKey, payload: event.payload, legacy: false })
}

const CARRIES_A_SESSION = [CARD_STARTED, CARD_CONTINUED, CARD_ANSWERED]
const ANSWER_ROUND_STEP = 'answer'

function answerRoundSessionsIn(bus: BusContract, db: DatabaseSync, cardId: number): string[] {
  return bus.ofCard(db, cardId, { types: [SESSION_HEARTBEAT] }).flatMap(event => event.data?.step === ANSWER_ROUND_STEP && typeof event.data.session === 'string' ? [event.data.session] : [])
}

export function cardSessionsIn(bus: BusContract, db: DatabaseSync, cardId: number): string[] {
  const carried = bus.ofCard(db, cardId, { types: CARRIES_A_SESSION }).flatMap(event => typeof event.data?.session === 'string' ? [event.data.session] : [])
  const stoppedRounds = [...new Set(answerRoundSessionsIn(bus, db, cardId))].filter(session => !carried.includes(session))
  return [...stoppedRounds, ...carried]
}

export interface CardBodyText {
  card_id: number
  text: string
}

export function cardBodyTexts(db: DatabaseSync): CardBodyText[] {
  return db.prepare(`SELECT card_id, text FROM ${CARD_BODIES} ORDER BY card_id`).all() as unknown as CardBodyText[]
}

export function cardBodyText(db: DatabaseSync, cardId: number): string | null {
  return (db.prepare(`SELECT text FROM ${CARD_BODIES} WHERE card_id = ?`).get(cardId) as { text: string } | undefined)?.text ?? null
}

export interface AdmittedBody {
  id: number
  text: string
  sha: string
}

export function admittedBodies(bus: BusContract, db: DatabaseSync, cardId: number): AdmittedBody[] {
  return bus.ofCard(db, cardId, { types: [CARD_ADMITTED], newestFirst: true }).flatMap(({ id, data }) => {
    const text = data?.text
    return typeof text === 'string' && data?.textSha === textSha(text) ? [{ id, text, sha: String(data.textSha) }] : []
  })
}

export function admittedBodyText(bus: BusContract, db: DatabaseSync, cardId: number): string | null {
  return admittedBodies(bus, db, cardId)[0]?.text ?? null
}

export function busAdmittedBodies(bus: BusContract, busPath: string): (cardId: number) => string | null {
  return (cardId) => {
    if (!existsSync(busPath))
      return null
    const db = bus.openReadOnly(busPath)
    try {
      return admittedBodyText(bus, db, cardId)
    }
    finally {
      db.close()
    }
  }
}

const ADMISSION_OF_THE_BODY = `SELECT admission_event_id FROM ${CARD_BODIES} WHERE card_id = ?`

export function admittedCardVersion(bus: BusContract, db: DatabaseSync, cardId: number): number | null {
  const row = db.prepare(ADMISSION_OF_THE_BODY).get(cardId) as { admission_event_id: number | null } | undefined
  if (row === undefined)
    return null
  const admission = row.admission_event_id === null ? null : bus.byId(db, Number(row.admission_event_id))
  return bus.cardVersion.of(admission?.payload ?? null)
}

function pathsNamedOutside(parked: ParkedTask, text: string): string[] {
  return pathsOutside(parked.task.touches, parked.creates, pathsIn(text)).filter(named => named !== FACTORY_TWIN)
}

export function pathsOutsideTheBody(db: DatabaseSync, cardId: number, text: string): string[] {
  const body = cardBodyText(db, cardId)
  const parsed = body === null ? null : parseParkingFile(`${cardId}.md`, body)
  return parsed?.kind === 'parked' ? pathsNamedOutside(parsed.parked, text) : []
}

export function cardOfBranch(db: DatabaseSync, branch: unknown): number | null {
  if (typeof branch !== 'string' || branch === '')
    return null
  const cards = db.prepare(`SELECT card_id FROM ${CARD_BODIES} WHERE branch = ? LIMIT 2`).all(branch) as { card_id: number }[]
  return cards.length === 1 ? cards[0]!.card_id : null
}

export function foldCardBody(db: DatabaseSync, event: StoredEvent): void {
  const payload = payloadOrNull(event)
  const text = payload?.text
  if (event.card_id === null || typeof text !== 'string' || payload?.textSha !== textSha(text))
    return
  const parsed = parseParkingFile(`${event.card_id}.md`, text)
  const columns = parsed.kind === 'parked' ? columnsOf(parsed.parked) : UNPARSED
  const lane = typeof payload.lane === 'string' ? payload.lane : null
  db.prepare(`
    INSERT INTO ${CARD_BODIES} (card_id, admission_event_id, text, text_sha, lane, who, priority, branch, touches, creates, card_line, contour, decision, depends)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (card_id) DO UPDATE SET admission_event_id = excluded.admission_event_id, text = excluded.text, text_sha = excluded.text_sha,
      lane = excluded.lane, who = excluded.who, priority = excluded.priority, branch = excluded.branch, touches = excluded.touches,
      creates = excluded.creates, card_line = excluded.card_line, contour = excluded.contour, decision = excluded.decision, depends = excluded.depends
  `).run(event.card_id, event.id, text, payload.textSha, lane, columns.who, columns.priority, columns.branch, columns.touches, columns.creates, columns.card_line, columns.contour, columns.decision, columns.depends)
}

const FOLDED_ADMISSION = `SELECT admission_event_id FROM ${CARD_BODIES} WHERE card_id = ?`

function carriesABody(payload: Record<string, unknown>): boolean {
  return typeof payload.text === 'string' && payload.textSha === textSha(payload.text)
}

export const SLICE_PARENTS_ACTOR = 'worker:slice-parent-backfill:by-hand'
export const SLICE_PARENTS_BUS_ACTOR = 'worker:slice-parent-backfill:bus'
export interface SliceParentsBackfill {
  recorded: boolean
  transfer: TransferredParents
}

function sliceParentTransfer(bus: BusContract, db: DatabaseSync): TransferredParents {
  const every = latestCardLines(bus, db)
  const lines = every.map(({ card, line }) => ({ card, line }))
  return parentsFromCardLines(lines.filter((_, at) => !every[at]!.carrying), lines)
}

function recordTransfer(bus: BusContract, db: DatabaseSync, ts: string, actor: string, transfer: TransferredParents): boolean {
  return bus.appendEvent(db, { ts, type: SLICE_PARENTS_BACKFILLED, actor, cardId: null, pr: null, head: null, dedupeKey: SLICE_PARENTS_BACKFILLED, payload: { cards: transfer.cards, unread: transfer.unread }, legacy: false })
}

export function backfillSliceParents(bus: BusContract, db: DatabaseSync, ts: string, actor: string = SLICE_PARENTS_ACTOR): SliceParentsBackfill {
  const transfer = sliceParentTransfer(bus, db)
  return { recorded: recordTransfer(bus, db, ts, actor, transfer), transfer }
}

export function backfillPendingSliceParents(bus: BusContract, db: DatabaseSync, ts: string): SliceParentsBackfill | null {
  const transfer = sliceParentTransfer(bus, db)
  if (Object.keys(transfer.cards).length === 0 && transfer.unread.length === 0)
    return null
  return { recorded: recordTransfer(bus, db, ts, SLICE_PARENTS_BUS_ACTOR, transfer), transfer }
}

export function bodyNotFoldedYet(bus: BusContract, db: DatabaseSync, cardId: number): boolean {
  const admissions = bus.ofCard(db, cardId, { types: [CARD_ADMITTED], newestFirst: true })
  const admission = admissions.find(({ data }) => data !== null && !isBackfill(data) && carriesABody(data))
  if (admission === undefined)
    return false
  const folded = db.prepare(FOLDED_ADMISSION).get(cardId) as { admission_event_id: number } | undefined
  return folded === undefined || Number(folded.admission_event_id) < Number(admission.id)
}

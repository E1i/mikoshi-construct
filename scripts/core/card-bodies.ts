import type { DatabaseSync } from 'node:sqlite'
import type { ParkedTask } from '../../src/card/parking.js'
import type { CardEvent } from '../../src/commands/intake/index.js'
import type { StoredEvent } from './stored.js'
import { existsSync } from 'node:fs'
import { parseParkingFile } from '../../src/card/parking.js'
import { textSha } from '../../src/card/text-sha.js'
import { AMEND_SOURCE, isLaneName, laneName, laneNumber, pathsNamedOutside } from '../../src/commands/intake/admit.js'
import { NOT_A_BACKFILL } from './backfill-source.js'
import { CARD_VERSION, CARD_VERSION_KEY, cardVersionIn } from './bus-version.js'
import { appendEvent, BUSY_TIMEOUT_MS } from './db.js'
import { CARD_ADMITTED, FACTORY_MODE } from './events.js'
import { openDatabase } from './sqlite.js'

export const CARD_BODIES = 'card_bodies'
export const FACTORY_MODES = ['window', 'parallel'] as const
export const DEFAULT_MODE: FactoryMode = 'window'
export const WINDOW_LANE = 'lane-window'

export type FactoryMode = typeof FACTORY_MODES[number]

const MODE_IN_FORCE = `SELECT json_extract(payload, '$.mode') AS mode FROM events WHERE legacy = 0 AND type = '${FACTORY_MODE}' ORDER BY id DESC LIMIT 1`

const LANE_OF_CARD = `SELECT json_extract(payload, '$.lane') AS lane FROM events WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND card_id = ? ORDER BY id DESC LIMIT 1`

const PREVIOUS_ADMISSION = `SELECT id, payload FROM events WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND card_id = ? ORDER BY id DESC LIMIT 1`

const ADMITTED_LANES = `SELECT DISTINCT json_extract(payload, '$.lane') AS lane FROM events WHERE legacy = 0 AND type = '${CARD_ADMITTED}'`

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

export function isFactoryMode(mode: unknown): mode is FactoryMode {
  return typeof mode === 'string' && (FACTORY_MODES as readonly string[]).includes(mode)
}

export function factoryMode(db: DatabaseSync): FactoryMode {
  const row = db.prepare(MODE_IN_FORCE).get() as { mode: unknown } | undefined
  return isFactoryMode(row?.mode) ? row.mode : DEFAULT_MODE
}

function laneOfCard(db: DatabaseSync, cardId: unknown): string | null {
  if (typeof cardId !== 'number')
    return null
  const lane = (db.prepare(LANE_OF_CARD).get(cardId) as { lane: unknown } | undefined)?.lane
  return typeof lane === 'string' && isLaneName(lane) ? lane : null
}

function newLane(db: DatabaseSync): string {
  const lanes = (db.prepare(ADMITTED_LANES).all() as { lane: unknown }[]).flatMap(row => typeof row.lane === 'string' ? [laneNumber(row.lane) ?? 0] : [])
  return laneName(Math.max(0, ...lanes) + 1)
}

export function admittedLane(db: DatabaseSync, cardId: number, depends: unknown): string {
  if (factoryMode(db) === 'window')
    return WINDOW_LANE
  const parents = Array.isArray(depends) ? depends : []
  return laneOfCard(db, cardId) ?? parents.map(parent => laneOfCard(db, parent)).find(lane => lane !== null) ?? newLane(db)
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

function versioned(db: DatabaseSync, event: CardEvent): CardEvent {
  if (event.type !== CARD_ADMITTED || typeof event.payload.text !== 'string')
    return event
  const previous = db.prepare(PREVIOUS_ADMISSION).get(event.cardId) as { id: number, payload: string } | undefined
  return { ...event, type: CARD_ADMITTED, payload: { ...event.payload, [CARD_VERSION_KEY]: CARD_VERSION, prevAdmissionId: previous?.id ?? null, prevTextSha: previous === undefined ? null : recordedTextSha(previous.payload) } }
}

export function laid(db: DatabaseSync, event: CardEvent): CardEvent {
  if (event.type !== CARD_ADMITTED)
    return event
  const kept = event.payload.source === AMEND_SOURCE ? laneOfCard(db, event.cardId) : null
  return { ...event, type: CARD_ADMITTED, payload: { ...event.payload, lane: kept ?? admittedLane(db, event.cardId, event.payload.depends) } }
}

export function appendCardEvent(db: DatabaseSync, actor: string, unversioned: CardEvent): boolean {
  const event = versioned(db, unversioned)
  return appendEvent(db, { ts: event.ts, type: event.type, actor, cardId: event.cardId, pr: null, head: null, dedupeKey: event.dedupeKey, payload: event.payload, legacy: false })
}

export function cardBodyText(db: DatabaseSync, cardId: number): string | null {
  return (db.prepare(`SELECT text FROM ${CARD_BODIES} WHERE card_id = ?`).get(cardId) as { text: string } | undefined)?.text ?? null
}

const ADMITTED_TEXTS = `SELECT id, json_extract(payload, '$.text') AS text, json_extract(payload, '$.textSha') AS sha FROM events WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND card_id = ? AND json_valid(payload) AND json_type(payload, '$.text') = 'text' ORDER BY id DESC`

export interface AdmittedBody {
  id: number
  text: string
  sha: string
}

export function admittedBodies(db: DatabaseSync, cardId: number): AdmittedBody[] {
  const rows = db.prepare(ADMITTED_TEXTS).all(cardId) as { id: number, text: string, sha: unknown }[]
  return rows.filter(row => row.sha === textSha(row.text)).map(row => ({ id: Number(row.id), text: row.text, sha: String(row.sha) }))
}

export function admittedBodyText(db: DatabaseSync, cardId: number): string | null {
  return admittedBodies(db, cardId)[0]?.text ?? null
}

export function busAdmittedBodies(busPath: string): (cardId: number) => string | null {
  return (cardId) => {
    if (!existsSync(busPath))
      return null
    const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    try {
      return admittedBodyText(db, cardId)
    }
    finally {
      db.close()
    }
  }
}

const ADMISSION_OF_THE_BODY = `SELECT admission.payload FROM ${CARD_BODIES} body LEFT JOIN events admission ON admission.id = body.admission_event_id WHERE body.card_id = ?`

export function admittedCardVersion(db: DatabaseSync, cardId: number): number | null {
  const row = db.prepare(ADMISSION_OF_THE_BODY).get(cardId) as { payload: string | null } | undefined
  return row === undefined ? null : cardVersionIn(row.payload)
}

export function pathsOutsideTheBody(db: DatabaseSync, cardId: number, text: string): string[] {
  const body = cardBodyText(db, cardId)
  const parsed = body === null ? null : parseParkingFile(`${cardId}.md`, body)
  return parsed?.kind === 'parked' ? pathsNamedOutside(parsed.parked, text) : []
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

const ADMISSIONS_WITH_TEXT = `
  SELECT id, payload FROM events
  WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND card_id = ? AND ${NOT_A_BACKFILL} AND json_valid(payload) AND json_type(payload, '$.text') = 'text'
  ORDER BY id DESC
`

const FOLDED_ADMISSION = `SELECT admission_event_id FROM ${CARD_BODIES} WHERE card_id = ?`

function carriesABody(payload: Record<string, unknown>): boolean {
  return typeof payload.text === 'string' && payload.textSha === textSha(payload.text)
}

export function bodyNotFoldedYet(db: DatabaseSync, cardId: number): boolean {
  const admissions = db.prepare(ADMISSIONS_WITH_TEXT).all(cardId) as { id: number, payload: string }[]
  const admission = admissions.find(row => carriesABody(JSON.parse(row.payload) as Record<string, unknown>))
  if (admission === undefined)
    return false
  const folded = db.prepare(FOLDED_ADMISSION).get(cardId) as { admission_event_id: number } | undefined
  return folded === undefined || Number(folded.admission_event_id) < Number(admission.id)
}

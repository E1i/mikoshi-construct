import type { DatabaseSync } from 'node:sqlite'
import type { CardAdmissionsPort, CardEvent, CardEventPort, RecordedIntake } from '../../src/commands/intake/index.js'
import type { BusPorts } from '../../src/program.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runMain } from 'citty'
import { parseParkingFile } from '../../src/card/parking.js'
import { textSha } from '../../src/card/text-sha.js'
import { isLaneName } from '../../src/commands/intake/admit.js'
import { createMain } from '../../src/program.js'
import { CARD_ADMITTED, CARD_MOVED } from '../core/events.js'
import { busCardStates } from '../ghosts/tasks.js'
import { INTAKE_ACTOR_PREFIX } from './admissions.js'
import { admittedLane, cardBodyText } from './card-bodies.js'
import { appendEvent, BUSY_TIMEOUT_MS, defaultBusPath, inTransaction, openBus } from './db.js'
import { openDatabase } from './sqlite.js'

const INTAKE_SUBCOMMAND = 'intake'
const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const SESSION_BY_HAND = 'by-hand'

const INTAKE_ADMISSIONS = `
  SELECT id, ts, card_id, payload FROM events
  WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND actor LIKE '${INTAKE_ACTOR_PREFIX}%' AND card_id IS NOT NULL
  ORDER BY id
`

const ANY_ADMISSION = `SELECT 1 FROM events WHERE type = '${CARD_ADMITTED}' AND card_id = ? LIMIT 1`

const PREVIOUS_ADMISSION = `SELECT id, payload FROM events WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND card_id = ? ORDER BY id DESC LIMIT 1`

export interface IntakeAdmission extends RecordedIntake {
  task: string
  corrections: unknown
  event: number
}

interface AdmissionRow { id: number, ts: string | null, card_id: number, payload: string }

function admissionOf(row: AdmissionRow): IntakeAdmission | null {
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown> | null
    if (typeof payload?.card !== 'string' || payload.bodySha === undefined)
      return null
    return { task: String(row.card_id), card: payload.card, bodySha: payload.bodySha, ts: row.ts, confirmation: payload.confirmation, source: payload.source, corrections: payload.corrections, event: row.id }
  }
  catch {
    return null
  }
}

export function intakeAdmissions(db: DatabaseSync): IntakeAdmission[] {
  return (db.prepare(INTAKE_ADMISSIONS).all() as unknown as AdmissionRow[]).flatMap(row => admissionOf(row) ?? [])
}

export function busIntakeAdmissions(busPath: string): IntakeAdmission[] {
  if (!existsSync(busPath))
    return []
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    return intakeAdmissions(db)
  }
  finally {
    db.close()
  }
}

export function busCardAdmissions(db: DatabaseSync): CardAdmissionsPort {
  return (cardId) => {
    const admission = intakeAdmissions(db).filter(entry => entry.task === String(cardId)).at(-1)
    if (admission === undefined)
      return null
    const text = cardBodyText(db, cardId)
    return text === null ? admission : { ...admission, text }
  }
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

export function versioned(db: DatabaseSync, event: CardEvent): CardEvent {
  if (event.type !== CARD_ADMITTED || typeof event.payload.text !== 'string')
    return event
  const previous = db.prepare(PREVIOUS_ADMISSION).get(event.cardId) as { id: number, payload: string } | undefined
  return { ...event, payload: { ...event.payload, prevAdmissionId: previous?.id ?? null, prevTextSha: previous === undefined ? null : recordedTextSha(previous.payload) } }
}

function laid(db: DatabaseSync, event: CardEvent): CardEvent {
  return event.type === CARD_ADMITTED ? { ...event, payload: { ...event.payload, lane: admittedLane(db, event.cardId, event.payload.depends) } } : event
}

function append(db: DatabaseSync, actor: string, unversioned: CardEvent): void {
  const event = versioned(db, unversioned)
  appendEvent(db, { ts: event.ts, type: event.type, actor, cardId: event.cardId, pr: null, head: null, dedupeKey: event.dedupeKey, payload: event.payload, legacy: false })
}

function admissionOfMove(move: CardEvent): CardEvent | null {
  const { lane, to } = move.payload
  if (typeof lane !== 'string' || !isLaneName(lane) || typeof to !== 'string')
    return null
  const file = path.join(to, `${move.cardId}.md`)
  if (!existsSync(file))
    return null
  const text = readFileSync(file, 'utf8')
  const parsed = parseParkingFile(path.basename(file), text)
  if (parsed.kind === 'refused')
    return null
  const { card } = parsed.parked.task
  return {
    type: CARD_ADMITTED,
    cardId: move.cardId,
    ts: move.ts,
    dedupeKey: `${CARD_ADMITTED}:${move.dedupeKey}`,
    payload: { card: card.line, lane, depends: card.depends, decision: card.decision, contour: card.contour, moved: move.dedupeKey, text, textSha: textSha(text) },
  }
}

function needsAnAdmission(event: CardEvent): boolean {
  return event.type === CARD_MOVED
}

export function busCardEvents(db: DatabaseSync, session: string = SESSION_BY_HAND): CardEventPort {
  const actor = `${INTAKE_ACTOR_PREFIX}${session}`
  return event => inTransaction(db, () => {
    if (needsAnAdmission(event) && db.prepare(ANY_ADMISSION).get(event.cardId) === undefined)
      throw new Error(`Refused: #${event.cardId} has no card.admitted in the bus, so the bus cannot hold its move; admit it first. Nothing was moved.`)
    append(db, actor, laid(db, event))
    const admitted = event.type === CARD_MOVED ? admissionOfMove(event) : null
    if (admitted !== null)
      append(db, actor, admitted)
  })
}

export function busIntakePorts(db: DatabaseSync, session?: string): BusPorts {
  return { cardEvents: busCardEvents(db, session), cardStates: () => busCardStates(defaultBusPath()), cardAdmissions: busCardAdmissions(db) }
}

async function main(): Promise<void> {
  const db = openBus(defaultBusPath())
  try {
    await runMain(createMain(busIntakePorts(db, process.env[SESSION_VARIABLE] || undefined)), { rawArgs: [INTAKE_SUBCOMMAND, ...process.argv.slice(2)] })
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()

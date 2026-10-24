import type { DatabaseSync } from 'node:sqlite'
import type { BusCardStates } from '../../src/card/closed.js'
import type { CardAdmissionsPort, CardEvent, CardEventPort, RecordedIntake } from '../../src/commands/intake/index.js'
import type { BusPorts } from '../../src/program.js'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runMain } from 'citty'
import { parseParkingFile } from '../../src/card/parking.js'
import { textSha } from '../../src/card/text-sha.js'
import { isLaneName } from '../../src/commands/intake/admit.js'
import { printExport, runExport } from '../../src/commands/intake/export.js'
import { parkedNumbers } from '../../src/commands/intake/numbers.js'
import { parkingTree } from '../../src/commands/intake/parking-tree.js'
import { createMain } from '../../src/program.js'
import { createUi } from '../../src/ui/console.js'
import { resolveTheme } from '../../src/ui/theme.js'
import { ForeignBusRefused } from '../core/bus-path.js'
import { CARD_ADMITTED, CARD_MOVED } from '../core/events.js'
import { INTAKE_ACTOR_PREFIX } from './admissions.js'
import { appendCardEvent, cardBodyText, laid } from './card-bodies.js'
import { BUSY_TIMEOUT_MS, defaultBusPath, inTransaction, openBus } from './db.js'
import { layLanes, repositoryLanes } from './lane-assign.js'
import { openDatabase } from './sqlite.js'

const INTAKE_SUBCOMMAND = 'intake'
const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const SESSION_BY_HAND = 'by-hand'
const EXPORT_FLAG = '--export'
const PLAIN_FLAG = '--plain'
const JOHNNY_FLAG = '--johnny'

const INTAKE_ADMISSIONS = `
  SELECT id, ts, card_id, payload FROM events
  WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND actor LIKE '${INTAKE_ACTOR_PREFIX}%' AND card_id IS NOT NULL
  ORDER BY id
`

const ANY_ADMISSION = `SELECT 1 FROM events WHERE type = '${CARD_ADMITTED}' AND card_id = ? LIMIT 1`

const HELD_CARDS = `
  SELECT card_id, state FROM cards WHERE state IS NOT NULL
  UNION ALL
  SELECT DISTINCT card_id, NULL FROM events WHERE card_id IS NOT NULL AND card_id NOT IN (SELECT card_id FROM cards WHERE state IS NOT NULL)
`

const HELD_WITHOUT_STATE = 'held'

const LATEST_ADMITTED_TEXT = `SELECT json_extract(payload, '$.text') AS text, json_extract(payload, '$.textSha') AS sha FROM events WHERE legacy = 0 AND type = '${CARD_ADMITTED}' AND card_id = ? AND json_type(payload, '$.text') = 'text' ORDER BY id DESC`

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

function unfoldedText(db: DatabaseSync, cardId: number): string | null {
  const rows = db.prepare(LATEST_ADMITTED_TEXT).all(cardId) as { text: string, sha: unknown }[]
  return rows.find(row => row.sha === textSha(row.text))?.text ?? null
}

function admittedText(db: DatabaseSync, cardId: number): string | null {
  return cardBodyText(db, cardId) ?? unfoldedText(db, cardId)
}

export function busCardAdmissions(db: DatabaseSync): CardAdmissionsPort {
  return (cardId) => {
    const admission = intakeAdmissions(db).filter(entry => entry.task === String(cardId)).at(-1)
    if (admission === undefined)
      return null
    const text = admittedText(db, cardId)
    return text === null ? admission : { ...admission, text }
  }
}

export function parkedCardNumbers(root: string = path.join(os.homedir(), '.construct', 'parking')): () => number[] {
  return () => {
    if (!existsSync(root))
      throw new Error(`the parking ${root} cannot be read, so no card number is allocated`)
    return parkingTree(root).flatMap(dir => parkedNumbers(readdirSync(dir)))
  }
}

function parkedText(to: string, cardId: number): string | null {
  const file = path.join(to, `${cardId}.md`)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

function admissionOfMove(db: DatabaseSync, move: CardEvent): CardEvent | null {
  const { lane, to } = move.payload
  if (typeof lane !== 'string' || !isLaneName(lane) || typeof to !== 'string')
    return null
  const text = admittedText(db, move.cardId) ?? parkedText(to, move.cardId)
  if (text === null)
    return null
  const parsed = parseParkingFile(`${move.cardId}.md`, text)
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

export function busCardEvents(db: DatabaseSync, session: string = SESSION_BY_HAND, lanes: () => number = repositoryLanes(process.cwd())): CardEventPort {
  const actor = `${INTAKE_ACTOR_PREFIX}${session}`
  return event => inTransaction(db, () => {
    if (needsAnAdmission(event) && db.prepare(ANY_ADMISSION).get(event.cardId) === undefined)
      throw new Error(`Refused: #${event.cardId} has no card.admitted in the bus, so the bus cannot hold its move; admit it first. Nothing was moved.`)
    appendCardEvent(db, actor, laid(db, event))
    const admitted = event.type === CARD_MOVED ? admissionOfMove(db, event) : null
    if (admitted !== null)
      appendCardEvent(db, actor, admitted)
    if (event.type === CARD_ADMITTED || admitted !== null)
      layLanes(db, lanes(), event.ts, actor, event.cardId)
  })
}

export function busHeldCards(db: DatabaseSync): BusCardStates {
  const rows = db.prepare(HELD_CARDS).all() as unknown as { card_id: number, state: string | null }[]
  return new Map(rows.map(row => [String(row.card_id), row.state ?? HELD_WITHOUT_STATE]))
}

export function busIntakePorts(db: DatabaseSync, session?: string, lanes?: () => number): BusPorts {
  return { cardEvents: busCardEvents(db, session, lanes), cardStates: () => busHeldCards(db), cardAdmissions: busCardAdmissions(db) }
}

export async function runBusIntake(db: DatabaseSync, argv: readonly string[], session?: string): Promise<void> {
  const exportAt = argv.indexOf(EXPORT_FLAG)
  if (exportAt !== -1) {
    const ui = createUi(resolveTheme({ plain: argv.includes(PLAIN_FLAG), johnny: argv.includes(JOHNNY_FLAG) }))
    process.exitCode = printExport(ui, runExport({ card: argv[exportAt + 1] ?? '', admissions: busCardAdmissions(db) }), text => process.stdout.write(text))
    return
  }
  await runMain(createMain(busIntakePorts(db, session)), { rawArgs: [INTAKE_SUBCOMMAND, ...argv] })
}

function intakeBusPath(): string | null {
  try {
    return defaultBusPath()
  }
  catch (error) {
    if (!(error instanceof ForeignBusRefused))
      throw error
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
    return null
  }
}

async function main(): Promise<void> {
  const busPath = intakeBusPath()
  if (busPath === null)
    return
  const db = openBus(busPath)
  try {
    await runBusIntake(db, process.argv.slice(2), process.env[SESSION_VARIABLE] || undefined)
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()

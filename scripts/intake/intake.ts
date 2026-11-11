import type { DatabaseSync } from 'node:sqlite'
import type { CardAdmissionsPort, CardEvent, CardEventPort, RecordedIntake } from '../../src/commands/intake/index.js'
import type { CardsOfTheBus } from '../../src/commands/intake/numbers.js'
import type { LadderRunPort } from '../../src/commands/run-record.js'
import type { BusPorts } from '../../src/program.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runMain } from 'citty'
import { parseParkingFile } from '../../src/card/parking.js'
import { textSha } from '../../src/card/text-sha.js'
import { isLaneName } from '../../src/commands/intake/admit.js'
import { PLAN_FIELD } from '../../src/commands/intake/check.js'
import { WINDOW_SHARD_VARIABLE } from '../../src/commands/intake/confirm.js'
import { printExport, runExport } from '../../src/commands/intake/export.js'
import { createMain } from '../../src/program.js'
import { createUi } from '../../src/ui/console.js'
import { resolveTheme } from '../../src/ui/theme.js'
import { BUS_DB_VARIABLE, ForeignBusRefused } from '../core/bus-path.js'
import { admittedBodyText, appendCardEvent, laid } from '../core/card-bodies.js'
import { appendEvent, BUSY_TIMEOUT_MS, defaultBusPath, inTransaction, openBus } from '../core/db.js'
import { CARD_ADMITTED, CARD_MOVED, CARD_PLANNED, CARD_UNPLANNED, LADDER_RUN, NUMBERS_FOREIGN, PLAN_CLOSED, PLAN_OPENED } from '../core/events.js'
import { OWNER } from '../core/inbox.js'
import { constructCommand, pnpmCommand } from '../core/owner-commands.js'
import { openDatabase } from '../core/sqlite.js'
import { assignMovedLane, layLanes, repositoryLanes } from '../nodes/launch/lane-assign.js'
import { activeWindowShards } from '../policy/shards.js'
import { clientAdapter } from '../ports/client/index.js'
import { tabWindowOf } from '../window/tab.js'
import { windowSessionOf } from '../window/window-heartbeat.js'
import { INTAKE_ACTOR_PREFIX } from './admissions.js'

const INTAKE_SUBCOMMAND = 'intake'
const RUN_RECORD_SUBCOMMAND = 'run-record'
const SESSION_BY_HAND = 'by-hand'
const EXPORT_FLAG = '--export'
const PLAIN_FLAG = '--plain'
const JOHNNY_FLAG = '--johnny'
const RELEASE_FLAG = '--release'
const OPEN_A_RELEASE = pnpmCommand('bus:request', 'plan --op open')

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

const FOREIGN_NUMBERS = `SELECT DISTINCT listed.value AS id FROM events, json_each(events.payload, '$.ids') AS listed WHERE events.legacy = 0 AND events.type = '${NUMBERS_FOREIGN}'`

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
    const text = admittedBodyText(db, cardId)
    return text === null ? admission : { ...admission, text }
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
  const text = admittedBodyText(db, move.cardId) ?? parkedText(to, move.cardId)
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

const PLAN_OPENED_BEFORE = `SELECT 1 FROM events WHERE legacy = 0 AND type = '${PLAN_OPENED}' AND json_extract(payload, '$.id') = ? LIMIT 1`

const PLAN_CLOSED_BEFORE = `SELECT 1 FROM events WHERE legacy = 0 AND type = '${PLAN_CLOSED}' AND json_extract(payload, '$.plan') = ? LIMIT 1`

interface AdmittedPlan { id: string, title: string, goal: string, file: string }

function admittedPlan(value: unknown): AdmittedPlan | null {
  const plan = value as Partial<Record<keyof AdmittedPlan, unknown>> | null
  const fields = [plan?.id, plan?.title, plan?.goal, plan?.file]
  return fields.every(field => typeof field === 'string' && field !== '') ? plan as AdmittedPlan : null
}

export function isOpenRelease(db: DatabaseSync, release: string): boolean {
  return db.prepare(PLAN_OPENED_BEFORE).get(release) !== undefined && db.prepare(PLAN_CLOSED_BEFORE).get(release) === undefined
}

const LATEST_PLANNING_OF_CARD = `SELECT type, json_extract(payload, '$.release') AS release FROM events WHERE legacy = 0 AND card_id = ? AND type IN ('${CARD_PLANNED}', '${CARD_UNPLANNED}') ORDER BY id DESC LIMIT 1`

function plannedRelease(db: DatabaseSync, cardId: number): unknown {
  const latest = db.prepare(LATEST_PLANNING_OF_CARD).get(cardId) as { type: string, release: unknown } | undefined
  return latest?.type === CARD_PLANNED ? latest.release : null
}

function releaseInBody(event: CardEvent): string | null {
  const { text } = event.payload
  if (typeof text !== 'string')
    return null
  const parsed = parseParkingFile(`${event.cardId}.md`, text)
  return parsed.kind === 'parked' ? parsed.parked.release : null
}

function releaseToEnter(db: DatabaseSync, event: CardEvent, flagged: string | undefined, planned: string | undefined): string | undefined {
  const named = releaseInBody(event)
  if (named === null)
    return flagged ?? planned
  if (flagged !== undefined && flagged !== named)
    throw new Error(`Refused: #${event.cardId} names release ${named} in its body and ${RELEASE_FLAG} names ${flagged}; keep one of them. Nothing was admitted.`)
  if (plannedRelease(db, event.cardId) === named)
    return undefined
  if (!isOpenRelease(db, named))
    throw new Error(`Refused: #${event.cardId} names release ${named} in its body, and that is no open release in the bus; open it with ${OPEN_A_RELEASE} first, or take the line out. Nothing was admitted.`)
  return named
}

function registerPlan(db: DatabaseSync, event: CardEvent, release: string | undefined): void {
  if (event.type !== CARD_ADMITTED)
    return
  const plan = admittedPlan(event.payload[PLAN_FIELD])
  const recorded = { ts: event.ts, actor: OWNER, pr: null, head: null, legacy: false }
  if (plan !== null && db.prepare(PLAN_OPENED_BEFORE).get(plan.id) === undefined)
    appendEvent(db, { ...recorded, type: PLAN_OPENED, cardId: null, dedupeKey: `${PLAN_OPENED}:intake:${plan.id}`, payload: { id: plan.id, title: plan.title, goal: plan.goal, plan_file: plan.file } })
  const into = releaseToEnter(db, event, release, plan?.id)
  if (into !== undefined)
    appendEvent(db, { ...recorded, type: CARD_PLANNED, cardId: event.cardId, dedupeKey: `${CARD_PLANNED}:${event.dedupeKey}:${into}`, payload: { release: into, card: event.cardId } })
}

function needsAnAdmission(event: CardEvent): boolean {
  return event.type === CARD_MOVED
}

export function busCardEvents(db: DatabaseSync, session: string = SESSION_BY_HAND, lanes: () => number = repositoryLanes(process.cwd()), release?: string): CardEventPort {
  const actor = `${INTAKE_ACTOR_PREFIX}${session}`
  return event => inTransaction(db, () => {
    if (needsAnAdmission(event) && db.prepare(ANY_ADMISSION).get(event.cardId) === undefined)
      throw new Error(`Refused: #${event.cardId} has no card.admitted in the bus, so the bus cannot hold its move; admit it first. Nothing was moved.`)
    appendCardEvent(db, actor, laid(db, event))
    registerPlan(db, event, release)
    const admitted = event.type === CARD_MOVED ? admissionOfMove(db, event) : null
    if (admitted !== null && appendCardEvent(db, actor, admitted))
      assignMovedLane(db, event.cardId, String(admitted.payload.lane), lanes(), event.ts, actor)
    if (event.type === CARD_ADMITTED || admitted !== null)
      layLanes(db, lanes(), event.ts, actor, event.cardId)
  })
}

export function busHeldCards(db: DatabaseSync): CardsOfTheBus {
  const rows = db.prepare(HELD_CARDS).all() as unknown as { card_id: number, state: string | null }[]
  const held = new Map(rows.map(row => [String(row.card_id), row.state ?? HELD_WITHOUT_STATE]))
  const foreign = db.prepare(FOREIGN_NUMBERS).all() as unknown as { id: number }[]
  return foreign.length === 0 ? held : Object.assign(held, { foreign: new Set(foreign.map(row => row.id)) })
}

export function busIntakePorts(db: DatabaseSync, session?: string, lanes?: () => number, release?: string): BusPorts {
  return { cardEvents: busCardEvents(db, session, lanes, release), cardStates: () => busHeldCards(db), cardAdmissions: busCardAdmissions(db) }
}

export async function runBusIntake(db: DatabaseSync, argv: readonly string[], session?: string): Promise<void> {
  const exportAt = argv.indexOf(EXPORT_FLAG)
  if (exportAt !== -1) {
    const ui = createUi(resolveTheme({ plain: argv.includes(PLAIN_FLAG), johnny: argv.includes(JOHNNY_FLAG) }))
    process.exitCode = printExport(ui, runExport({ card: argv[exportAt + 1] ?? '', admissions: busCardAdmissions(db) }), text => process.stdout.write(text))
    return
  }
  const releaseAt = argv.indexOf(RELEASE_FLAG)
  const release = releaseAt === -1 ? undefined : argv[releaseAt + 1] ?? ''
  if (release !== undefined && !isOpenRelease(db, release)) {
    process.stderr.write(`Refused: ${RELEASE_FLAG} ${release} names no open release in the bus; open it with ${OPEN_A_RELEASE} first. Nothing was admitted.\n`)
    process.exitCode = 1
    return
  }
  const rest = releaseAt === -1 ? argv : [...argv.slice(0, releaseAt), ...argv.slice(releaseAt + 2)]
  await runMain(createMain(busIntakePorts(db, session, undefined, release)), { rawArgs: [INTAKE_SUBCOMMAND, ...rest] })
}

function refused(message: string): null {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
  return null
}

function namesItsBus(): boolean {
  return (process.env[BUS_DB_VARIABLE] ?? '') !== ''
}

function intakeBusPath(): string | null {
  try {
    const busPath = defaultBusPath()
    if (namesItsBus() || existsSync(busPath))
      return busPath
    return refused(`Refused: no bus at ${busPath}, and a card number comes only from the bus; run construct-factory or ${constructCommand('attach')} in this repository first, or name the bus in ${BUS_DB_VARIABLE}. No bus was created and no number assigned.`)
  }
  catch (error) {
    if (!(error instanceof ForeignBusRefused))
      throw error
    return refused(error.message)
  }
}

export function windowShardOfRun(db: DatabaseSync, env: NodeJS.ProcessEnv, now: Date): string | null {
  if (windowSessionOf(env) === null && tabWindowOf(env) === null)
    return null
  return activeWindowShards(db, now)[0]?.id ?? null
}

export const busLadderRun: LadderRunPort = (busPath, event) => {
  const db = openBus(busPath)
  try {
    return appendEvent(db, { ...event, type: LADDER_RUN, pr: null, head: null, legacy: false })
  }
  finally {
    db.close()
  }
}

async function runRunRecord(argv: readonly string[]): Promise<void> {
  await runMain(createMain({ ladderRun: busLadderRun }), { rawArgs: [...argv] })
}

export async function intakeMain(argv: readonly string[]): Promise<void> {
  if (argv[0] === RUN_RECORD_SUBCOMMAND) {
    await runRunRecord(argv)
    return
  }
  const busPath = intakeBusPath()
  if (busPath === null)
    return
  const db = openBus(busPath)
  try {
    const shard = windowShardOfRun(db, process.env, new Date())
    if (shard !== null)
      process.env[WINDOW_SHARD_VARIABLE] = shard
    await runBusIntake(db, argv, clientAdapter().ownSession(process.env) ?? undefined)
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await intakeMain(process.argv.slice(2))

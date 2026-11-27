import type { DatabaseSync } from 'node:sqlite'
import type { CardAdmissionsPort, CardEvent, CardEventPort, RecordedIntake } from '../../src/commands/intake/index.js'
import type { CardsOfTheBus } from '../../src/commands/intake/numbers.js'
import type { CreatesOwnerRefusal, ModuleDeclaration } from '../core/declarations.js'
import type { EventSlice } from '../ports/bus-read.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseParkingFile } from '../../src/card/parking.js'
import { textSha } from '../../src/card/text-sha.js'
import { PLAN_FIELD } from '../../src/commands/intake/check.js'
import { BUS_CONTRACT } from '../core/bus-adapter.js'
import { admittedBodyText, appendCardEvent, laid } from '../core/card-bodies.js'
import { heldCardStates } from '../core/card-readings.js'
import { appendEvent, BUSY_TIMEOUT_MS, inTransaction } from '../core/db.js'
import { createsOwnerRefusals, MODULE_FILES, MODULES_KIND, readDeclarations } from '../core/declarations.js'
import { CARD_ADMITTED, CARD_MOVED, CARD_PLANNED, CARD_UNPLANNED, NUMBERS_FOREIGN, PLAN_CLOSED, PLAN_OPENED } from '../core/events.js'
import { DECLARATION_SUFFIX, DECLARATIONS_FOLDER } from '../core/generated-files.js'
import { OWNER } from '../core/inbox.js'
import { pnpmCommand } from '../core/owner-commands.js'
import { openDatabase } from '../core/sqlite.js'
import { createdPaths, withinTouches } from '../policy/touch-scope.js'
import { ANY, BusRead } from '../ports/bus-read.js'
import { withWitnessRecords, witnessRecordsOf } from '../quality/witness-records.js'
import { INTAKE_ACTOR_PREFIX } from './admissions.js'

const SESSION_BY_HAND = 'by-hand'
export const RELEASE_FLAG = '--release'
export const OPEN_A_RELEASE = pnpmCommand('bus:request', 'plan --op open')

const HELD_WITHOUT_STATE = 'held'

const ADMISSION_FIELDS = ['card', 'bodySha', 'confirmation', 'source', 'corrections'] as const

type AdmissionSlice = EventSlice<typeof CARD_ADMITTED, typeof ADMISSION_FIELDS[number]>

export interface IntakeAdmission extends RecordedIntake {
  task: string
  corrections: unknown
  event: number
}

function admissionOf({ id, ts, card, fields }: AdmissionSlice): IntakeAdmission | null {
  if (typeof fields.card !== 'string' || fields.bodySha === undefined)
    return null
  return { task: String(card), card: fields.card, bodySha: fields.bodySha, ts, confirmation: fields.confirmation, source: fields.source, corrections: fields.corrections, event: id }
}

export function intakeAdmissions(db: DatabaseSync): IntakeAdmission[] {
  return new BusRead(db).where({ card: ANY, actor: INTAKE_ACTOR_PREFIX }).slice(CARD_ADMITTED, ADMISSION_FIELDS).flatMap(slice => admissionOf(slice) ?? [])
}

function hasAnAdmission(db: DatabaseSync, cardId: number): boolean {
  return new BusRead(db).where({ card: cardId, legacy: true }).slice(CARD_ADMITTED, [], 'last').length > 0
}

function foreignNumbers(db: DatabaseSync): Set<number> {
  const listed = new BusRead(db).slice(NUMBERS_FOREIGN, ['ids']).flatMap(slice => Array.isArray(slice.fields.ids) ? slice.fields.ids as number[] : [])
  return new Set(listed)
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
    const text = admittedBodyText(BUS_CONTRACT, db, cardId)
    return withWitnessRecords(text === null ? admission : { ...admission, text }, witnessRecordsOf(db, cardId))
  }
}

function parkedText(to: string, cardId: number): string | null {
  const file = path.join(to, `${cardId}.md`)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

function admissionOfMove(db: DatabaseSync, move: CardEvent): CardEvent | null {
  const { to } = move.payload
  if (typeof to !== 'string')
    return null
  const text = admittedBodyText(BUS_CONTRACT, db, move.cardId) ?? parkedText(to, move.cardId)
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
    payload: { card: card.line, depends: card.depends, decision: card.decision, contour: card.contour, moved: move.dedupeKey, text, textSha: textSha(text) },
  }
}

function planOpenedBefore(db: DatabaseSync, release: string): boolean {
  return new BusRead(db).slice(PLAN_OPENED, ['id']).some(opened => opened.fields.id === release)
}

function planClosedBefore(db: DatabaseSync, release: string): boolean {
  return new BusRead(db).slice(PLAN_CLOSED, ['plan']).some(closed => closed.fields.plan === release)
}

interface AdmittedPlan { id: string, title: string, goal: string, file: string }

function admittedPlan(value: unknown): AdmittedPlan | null {
  const plan = value as Partial<Record<keyof AdmittedPlan, unknown>> | null
  const fields = [plan?.id, plan?.title, plan?.goal, plan?.file]
  return fields.every(field => typeof field === 'string' && field !== '') ? plan as AdmittedPlan : null
}

export function isOpenRelease(db: DatabaseSync, release: string): boolean {
  return planOpenedBefore(db, release) && !planClosedBefore(db, release)
}

function plannedRelease(db: DatabaseSync, cardId: number): unknown {
  const ofCard = new BusRead(db).where({ card: cardId })
  const planned = ofCard.slice(CARD_PLANNED, ['release'], 'last')[0]
  const unplanned = ofCard.slice(CARD_UNPLANNED, [], 'last')[0]
  return planned !== undefined && planned.id > (unplanned?.id ?? 0) ? planned.fields.release ?? null : null
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
  if (plan !== null && !planOpenedBefore(db, plan.id))
    appendEvent(db, { ...recorded, type: PLAN_OPENED, cardId: null, dedupeKey: `${PLAN_OPENED}:intake:${plan.id}`, payload: { id: plan.id, title: plan.title, goal: plan.goal, plan_file: plan.file } })
  const into = releaseToEnter(db, event, release, plan?.id)
  if (into !== undefined)
    appendEvent(db, { ...recorded, type: CARD_PLANNED, cardId: event.cardId, dedupeKey: `${CARD_PLANNED}:${event.dedupeKey}:${into}`, payload: { release: into, card: event.cardId } })
}

function needsAnAdmission(event: CardEvent): boolean {
  return event.type === CARD_MOVED
}

function whatLetsItPass(refusal: CreatesOwnerRefusal): string {
  const add = refusal.add.length === 0 ? '' : `; add ${refusal.add.join(', ')} to touches`
  if (refusal.owner !== null)
    return `${refusal.path} belongs to module ${refusal.owner}${add}`
  if (refusal.modules.length === 0)
    return `${refusal.path} resolves to no module and no module declares a folder near it; widen a ${DECLARATIONS_FOLDER}/${MODULES_KIND}/<module>${DECLARATION_SUFFIX} to cover it and add that file and ${MODULE_FILES} to touches`
  return `${refusal.path} resolves to no module; widen ${refusal.modules.join(' or ')} to cover it${add}`
}

export function createsOwnerRefusalOf(modules: readonly ModuleDeclaration[], event: CardEvent): string | null {
  const { text } = event.payload
  if (event.type !== CARD_ADMITTED || typeof text !== 'string' || modules.length === 0)
    return null
  const parsed = parseParkingFile(`${event.cardId}.md`, text)
  if (parsed.kind === 'refused')
    return null
  const { touches } = parsed.parked.task
  const refusals = createsOwnerRefusals(modules, createdPaths(parsed.parked.creates), file => withinTouches(file, touches))
  if (refusals.length === 0)
    return null
  return `Refused: #${event.cardId} creates a file whose owner module its touches do not reach: ${refusals.map(whatLetsItPass).join('; ')}. Nothing was admitted.`
}

function declaredModules(root: string | undefined): readonly ModuleDeclaration[] {
  return root === undefined ? [] : readDeclarations(root).modules
}

export function busCardEvents(db: DatabaseSync, session: string = SESSION_BY_HAND, release?: string, declarationsRoot?: string): CardEventPort {
  const actor = `${INTAKE_ACTOR_PREFIX}${session}`
  const modules = (): readonly ModuleDeclaration[] => declaredModules(declarationsRoot)
  const refuseUnowned = (events: readonly CardEvent[], declared: readonly ModuleDeclaration[]): void => {
    for (const event of events) {
      const unowned = createsOwnerRefusalOf(declared, event)
      if (unowned !== null)
        throw new Error(unowned)
    }
  }
  const record = (event: CardEvent): void => {
    if (needsAnAdmission(event) && !hasAnAdmission(db, event.cardId))
      throw new Error(`Refused: #${event.cardId} has no card.admitted in the bus, so the bus cannot hold its move; admit it first. Nothing was moved.`)
    appendCardEvent(BUS_CONTRACT, db, actor, laid(db, event))
    registerPlan(db, event, release)
    const admitted = event.type === CARD_MOVED ? admissionOfMove(db, event) : null
    if (admitted !== null)
      appendCardEvent(BUS_CONTRACT, db, actor, admitted)
  }
  const recordAll = (events: readonly CardEvent[]): void => {
    if (events.some(event => event.type === CARD_ADMITTED))
      refuseUnowned(events, modules())
    inTransaction(db, () => events.forEach(record))
  }
  return Object.assign((event: CardEvent) => recordAll([event]), { allOrNothing: recordAll })
}

export function busHeldCards(db: DatabaseSync): CardsOfTheBus {
  const held = new Map([...heldCardStates(db)].map(([card, state]) => [String(card), state ?? HELD_WITHOUT_STATE]))
  const foreign = foreignNumbers(db)
  return foreign.size === 0 ? held : Object.assign(held, { foreign })
}

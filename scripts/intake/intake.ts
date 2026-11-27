import type { DatabaseSync } from 'node:sqlite'
import type { CardAdmissionsPort, CardEvent, CardEventPort, RecordedIntake } from '../../src/commands/intake/index.js'
import type { CardsOfTheBus } from '../../src/commands/intake/numbers.js'
import type { LadderRunPort } from '../../src/commands/run-record.js'
import type { BusPorts } from '../../src/program.js'
import type { CreatesOwnerRefusal, ModuleDeclaration } from '../core/declarations.js'
import type { RecomputeFigures, RecomputeLedger, TableOrder } from '../nodes/merge/weights-drift.js'
import type { EventSlice } from '../ports/bus-read.js'
import type { GitHub } from '../ports/github.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runMain } from 'citty'
import { parkingFileText, parseParkingFile } from '../../src/card/parking.js'
import { textSha } from '../../src/card/text-sha.js'
import { PLAN_FIELD } from '../../src/commands/intake/check.js'
import { bodySha, WINDOW_SHARD_VARIABLE } from '../../src/commands/intake/confirm.js'
import { printExport, runExport } from '../../src/commands/intake/export.js'
import { nextCardNumbers } from '../../src/commands/intake/numbers.js'
import { createMain } from '../../src/program.js'
import { createUi } from '../../src/ui/console.js'
import { resolveTheme } from '../../src/ui/theme.js'
import { RECOMPUTE_DRIFTED_SHARE, WEIGHTS_PATH } from '../ci/weights-law.js'
import { BUS_CONTRACT } from '../core/bus-adapter.js'
import { BUS_DB_VARIABLE, ForeignBusRefused } from '../core/bus-path.js'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../core/card-automaton.js'
import { admittedBodyText, appendCardEvent, laid } from '../core/card-bodies.js'
import { heldCardStates } from '../core/card-readings.js'
import { appendEvent, BUSY_TIMEOUT_MS, defaultBusPath, inTransaction, openBus } from '../core/db.js'
import { createsOwnerRefusals, MODULE_FILES, MODULES_KIND, readDeclarations } from '../core/declarations.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_MOVED, CARD_PLANNED, CARD_UNPLANNED, LADDER_RUN, NUMBERS_FOREIGN, PLAN_CLOSED, PLAN_OPENED, PR_OPENED } from '../core/events.js'
import { DECLARATION_SUFFIX, DECLARATIONS_FOLDER } from '../core/generated-files.js'
import { OWNER } from '../core/inbox.js'
import { constructCommand, pnpmCommand } from '../core/owner-commands.js'
import { openDatabase } from '../core/sqlite.js'
import { launchWaitsOf } from '../nodes/launch/lane-assign.js'
import { latestGitHubNumber } from '../nodes/review/pr-close.js'
import { BusDecisions } from '../policy/decisions/index.js'
import { activeWindowShards } from '../policy/shards.js'
import { createdPaths, withinTouches } from '../policy/touch-scope.js'
import { ANY, BusRead } from '../ports/bus-read.js'
import { clientAdapter } from '../ports/session.js'
import { withWitnessRecords, witnessRecordsOf } from '../quality/witness-records.js'
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

export const WEIGHTS_DRIFT_SOURCE = 'weights-drift'
export const WEIGHTS_DRIFT_ACTOR = `${INTAKE_ACTOR_PREFIX}${WEIGHTS_DRIFT_SOURCE}`
export const WEIGHTS_DRIFT_UNREAD = 'weights_drift_unread'
export const RECOMPUTE_WITNESS = pnpmCommand('exec', 'vitest', 'run', 'scripts/tests/ci/test-weights-fresh.test.ts')
const RECOMPUTE_MILESTONE = 'construct'
const ENDED_CARD_STATES: ReadonlySet<string> = new Set([MERGED_CARD, CLOSED_CARD, DROPPED_CARD])
const WEIGHTS_REPO = 'repos/{owner}/{repo}'
const LAST_TABLE_CHANGE = `${WEIGHTS_REPO}/commits?path=${WEIGHTS_PATH}&per_page=1`
const AT_OR_AFTER_CHANGE: ReadonlySet<unknown> = new Set(['ahead', 'identical'])
const BEFORE_CHANGE: ReadonlySet<unknown> = new Set(['behind', 'diverged'])

export function weightsTableOrder(gitHub: GitHub, head: string): TableOrder {
  const commits = gitHub(LAST_TABLE_CHANGE)
  if (commits.status !== 200 || !Array.isArray(commits.body))
    return { kind: 'unread', why: `GitHub answered ${commits.status} to the read of the last change of ${WEIGHTS_PATH} on main` }
  const change = (commits.body[0] as { sha?: unknown } | undefined)?.sha
  if (commits.body.length === 0 || change === head)
    return { kind: 'current' }
  if (typeof change !== 'string')
    return { kind: 'unread', why: `GitHub named the last change of ${WEIGHTS_PATH} on main with no sha` }
  const compared = gitHub(`${WEIGHTS_REPO}/compare/${change}...${head}`)
  const status = (compared.body as { status?: unknown } | null)?.status
  if (compared.status === 200 && AT_OR_AFTER_CHANGE.has(status))
    return { kind: 'current' }
  if (compared.status === 200 && BEFORE_CHANGE.has(status))
    return { kind: 'behind', change }
  return { kind: 'unread', why: `GitHub answered ${compared.status} with status ${String(status)} to the comparison of ${head} with ${change}, the last change of ${WEIGHTS_PATH}` }
}

function recomputeSlug(run: number): string {
  return `test-weights-recompute-${run}`
}

export function recomputeCardText(id: number, figures: RecomputeFigures): string {
  return parkingFileText({
    card: `#${id} ${recomputeSlug(figures.run)} [implement/${RECOMPUTE_MILESTONE}/S/cheap/auto] · depends — · blocks —`,
    branch: `feat/${recomputeSlug(figures.run)}`,
    touches: [WEIGHTS_PATH],
    continue: 'stop',
    who: 'shift',
    priority: 'p1',
    body: [
      `Recompute of ${WEIGHTS_PATH} admitted by the bus under D-600: CI run ${figures.run} on main at ${figures.head} measured ${figures.drifted} test files whose weight is missing or off, carrying ${figures.driftedSeconds.toFixed(1)} s, ${(figures.share * 100).toFixed(1)}% of the longest shard's ${figures.longestShardSeconds.toFixed(1)} s, above the ${(RECOMPUTE_DRIFTED_SHARE * 100).toFixed(0)}% line.`,
      '',
      `The bus computed the new table from that run and wrote it into this card's tree at ${WEIGHTS_PATH} before the session started. Change nothing else: commit that file as it stands and open the pull request. The table is ready; this card needs no network and no recompute of its own.`,
      '',
      'Witnesses:',
      `- ${RECOMPUTE_WITNESS}`,
    ].join('\n'),
  })
}

function recomputeEventOf(id: number, text: string, run: number, at: Date): CardEvent {
  const parsed = parseParkingFile(`${id}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(`the recompute card #${id} does not parse: ${parsed.reason}`)
  const { card: { line, depends, decision, contour } } = parsed.parked.task
  return {
    type: CARD_ADMITTED,
    cardId: id,
    ts: at.toISOString(),
    dedupeKey: `${CARD_ADMITTED}:${WEIGHTS_DRIFT_SOURCE}:run-${run}`,
    payload: { card: line, depends, decision, contour, confirmation: 'auto', corrections: [], bodySha: bodySha(text), text, textSha: textSha(text), source: WEIGHTS_DRIFT_SOURCE },
  }
}

export interface WeightsRecomputeParts {
  db: DatabaseSync
  gitHub: GitHub
  hand: (cardId: number, file: string, text: string) => void
  clock: () => Date
}

export class BusWeightsRecompute implements RecomputeLedger {
  constructor(private readonly parts: WeightsRecomputeParts) {}

  private get read(): BusRead {
    return new BusRead(this.parts.db).where({ actor: WEIGHTS_DRIFT_ACTOR })
  }

  decided(run: number): boolean {
    const slug = ` ${recomputeSlug(run)} `
    return this.read.slice(CARD_ADMITTED, ['card']).some(event => String(event.fields.card).includes(slug))
      || this.read.slice(BOARD_ALARM, ['reason', 'ref']).some(event => event.fields.reason === WEIGHTS_DRIFT_UNREAD && event.fields.ref === String(run))
  }

  tableOrder(head: string): TableOrder {
    return weightsTableOrder(this.parts.gitHub, head)
  }

  openCard(): number | null {
    const card = this.read.slice(CARD_ADMITTED, [], 'last')[0]?.card ?? null
    if (card === null)
      return null
    const state = busHeldCards(this.parts.db).get(String(card))
    return state !== undefined && ENDED_CARD_STATES.has(state) ? null : card
  }

  admit(figures: RecomputeFigures, table: string): number {
    const onGitHub = latestGitHubNumber(this.parts.gitHub)
    const { db } = this.parts
    return inTransaction(db, () => {
      const [id] = nextCardNumbers(busHeldCards(db), [this.latestPrInTheBus(), onGitHub], 1)
      const text = recomputeCardText(id!, figures)
      this.parts.hand(id!, WEIGHTS_PATH, table)
      const at = this.parts.clock()
      if (!appendCardEvent(BUS_CONTRACT, db, WEIGHTS_DRIFT_ACTOR, laid(db, recomputeEventOf(id!, text, figures.run, at))))
        throw new Error(`the card.admitted of recompute card #${id} was not appended`)
      return id!
    })
  }

  unread(run: number, why: string): void {
    appendEvent(this.parts.db, { ts: this.parts.clock().toISOString(), type: BOARD_ALARM, actor: WEIGHTS_DRIFT_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${WEIGHTS_DRIFT_UNREAD}:run-${run}`, payload: { reason: WEIGHTS_DRIFT_UNREAD, ref: String(run), detail: why }, legacy: false })
  }

  private latestPrInTheBus(): number {
    return new BusRead(this.parts.db).where({ pr: ANY }).slice(PR_OPENED, [], 'last')[0]?.pr ?? 0
  }
}

export function busIntakePorts(db: DatabaseSync, session?: string, release?: string, declarationsRoot?: string): BusPorts {
  return { cardEvents: busCardEvents(db, session, release, declarationsRoot), cardStates: () => busHeldCards(db), cardAdmissions: busCardAdmissions(db), decisions: new BusDecisions(db), cardWaits: launchWaitsOf(db) }
}

export async function runBusIntake(db: DatabaseSync, argv: readonly string[], session?: string, declarationsRoot?: string): Promise<void> {
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
  await runMain(createMain(busIntakePorts(db, session, release, declarationsRoot)), { rawArgs: [INTAKE_SUBCOMMAND, ...rest] })
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
    await runBusIntake(db, argv, clientAdapter().ownSession(process.env) ?? undefined, process.cwd())
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await intakeMain(process.argv.slice(2))

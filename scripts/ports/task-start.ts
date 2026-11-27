import type { DatabaseSync } from 'node:sqlite'
import type { Card } from '../../src/card/grammar.js'
import type { ParkedTask } from '../../src/card/parking.js'
import type { CheapForecast } from '../../src/commands/cost/index.js'
import type { Signal, SignalStyle } from '../../src/ui/signal.js'
import type { BusEventRow } from '../core/bus-contract.js'
import type { BusEvent } from '../core/db.js'
import type { BodyAdmission } from '../core/queue.js'
import { existsSync } from 'node:fs'
import { cardLine, cardTerms, parseCard } from '../../src/card/grammar.js'
import { parseParkingFile } from '../../src/card/parking.js'
import { RISK_LEVELS, RISK_PREFIX } from '../../src/card/risk.js'
import { bodySha, bodyShaWithoutTouches } from '../../src/commands/intake/confirm.js'
import { readMilestones } from '../../src/manifest.js'
import { PLAIN_STYLE, renderSignal } from '../../src/ui/signal.js'
import { isBackfill } from '../core/backfill-source.js'
import { unsatisfiedDependencies } from '../core/card-automaton.js'
import { appendEvent, inTransaction, openBus } from '../core/db.js'
import { ENTRY_RESULT, ENTRY_SCHEMA } from '../core/entry.js'
import { CARD_ADMITTED, CARD_STARTED, INTAKE_EVENT, INTAKE_MOVE_EVENT } from '../core/events.js'
import { legacyHistory } from '../core/legacy-history.js'
import { ADMIT_COMMAND, pnpmCommand } from '../core/owner-commands.js'
import * as prs from '../core/pr-readings.js'
import { cardBodyAdmissionOf, LEASED } from '../core/queue.js'
import { slotsVariable } from '../supervisor/scheduler.js'
import { STARTER_ACTOR, windowOpenPrs } from '../window/window-prs.js'
import { SESSION_VARIABLE } from './client/claude/adapter.js'
import { processGit } from './git.js'
import { adoptTree, cutTree, treeOriginLine } from './worktree.js'

export const TECHNOLOGY_WORDS = ['database'] as const

export const PREFIX = '[task:start] '
const START_USAGE = `usage: ${pnpmCommand('task:start', '<branch> --card "<card>"')}`
const WITHOUT_INTAKE_USAGE = '[--without-intake "<reason>"]'
export const USAGE = `${START_USAGE} ${WITHOUT_INTAKE_USAGE}`
export const ADOPT_USAGE = `${START_USAGE} --adopt <tree> ${WITHOUT_INTAKE_USAGE}`
const SAFE_BRANCH = /^[^\s-]\S*$/

export type TaskStartContract = Parameters<typeof unsatisfiedDependencies>[0]

export interface TaskStartFlags {
  card: string
  adopt: string
  withoutIntake: string
}

export interface TaskStartDeps {
  contract: TaskStartContract
  flags: TaskStartFlags
  cwd: string
  git: (cwd: string, args: string[]) => string
  install: (cwd: string, args: string[]) => void
  exists: (target: string) => boolean
  bus: string
  now: () => Date
  session: string | undefined
  shift?: string
  worktreeHome?: string
  treeOf?: (id: string) => string
  style?: SignalStyle
  cardBody?: (cardId: number) => string | null
  windowLimit?: () => number
}

export const WINDOW_LIMIT_SLOTS = 'review'

export interface TaskStartResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
  worktree?: string
}

type Admission
  = | { kind: 'admitted', by: 'bus', event: string, ts: string, body?: BodyAdmission }
    | { kind: 'admitted', by: 'waiver', flag: string, reason: string }
    | { kind: 'refused', reason: string }

type AdmittedRow = Pick<BusEventRow, 'ts' | 'dedupe_key' | 'payload'>

const ADMISSION_SOURCE_TYPES = [INTAKE_EVENT, INTAKE_MOVE_EVENT]

function admissionsNewestFirst(contract: TaskStartContract, db: DatabaseSync, cardId: number): BusEventRow[] {
  return contract.ofCard(db, cardId, { types: [CARD_ADMITTED], legacy: false, newestFirst: true })
}

function latestAdmissionOf(contract: TaskStartContract, db: DatabaseSync, cardId: number): BusEventRow | null {
  return admissionsNewestFirst(contract, db, cardId).find(row => row.data === null || !isBackfill(row.data)) ?? null
}

function admissionSourcesOf(contract: TaskStartContract, db: DatabaseSync, cardId: number): BusEventRow[] {
  const keys = admissionsNewestFirst(contract, db, cardId).map(admitted => admitted.data?.admission).filter(key => typeof key === 'string')
  if (keys.length === 0)
    return []
  const sourceOf = new Map(contract.events(db, { types: ADMISSION_SOURCE_TYPES, legacy: true }).map(source => [source.dedupe_key, source]))
  return keys.flatMap(key => sourceOf.get(key) ?? [])
}

function launchLeased(contract: TaskStartContract, db: DatabaseSync, cardId: number | null): boolean {
  return cardId !== null && contract.tasksOfCard(db, cardId, { queue: 'launch' }).some(task => task.state === LEASED)
}

const STARTER_SESSION_BY_HAND = 'by-hand'

function unsatisfiedIn(contract: TaskStartContract, bus: string, depends: readonly number[]): number[] {
  if (!existsSync(bus))
    return [...depends]
  const db = openBus(bus)
  try {
    return unsatisfiedDependencies(contract, db, { pullRequests: () => prs.all(db), journal: () => legacyHistory(db) })(depends)
  }
  finally {
    db.close()
  }
}

function heldByWindow(bus: string): number[] {
  const db = openBus(bus)
  try {
    return windowOpenPrs(db).map(open => open.pr)
  }
  finally {
    db.close()
  }
}

function isShiftCard(cardFile: CardFile): boolean {
  return cardFile.kind === 'parked' && cardFile.parked.who === 'shift'
}

function windowAtLimit(deps: TaskStartDeps, id: string, cardFile: CardFile): string | null {
  if (deps.windowLimit === undefined || isShiftCard(cardFile))
    return null
  let limit: number
  try {
    limit = deps.windowLimit()
  }
  catch (error) {
    return `the window limit cannot be read: ${error instanceof Error ? error.message : String(error)}; nothing written`
  }
  const held = heldByWindow(deps.bus)
  if (held.length < limit)
    return null
  return `the window holds ${held.length} open pull requests (${held.map(pr => `PR #${pr}`).join(', ')}), at its limit of ${limit} from ${slotsVariable(WINDOW_LIMIT_SLOTS)}: move one to its merge or close before starting #${id}; nothing written`
}

function sameCard(recorded: string, card: Card): boolean {
  const parsed = parseCard(recorded)
  return parsed.kind === 'card' && cardLine(parsed.card) === cardLine(card)
}

function stringField(json: string, field: string): string | undefined {
  try {
    const value = (JSON.parse(json) as Record<string, unknown>)[field]
    return typeof value === 'string' ? value : undefined
  }
  catch {
    return undefined
  }
}

function admittedCardLine(contract: TaskStartContract, db: DatabaseSync, id: number, latest: AdmittedRow): string | undefined {
  const own = stringField(latest.payload, 'card')
  if (own !== undefined)
    return own
  return admissionSourcesOf(contract, db, id).map(source => stringField(source.payload, 'card')).find(line => line !== undefined)
}

function busAdmission(contract: TaskStartContract, bus: string, card: Card, withoutIntake: string): Admission | undefined {
  const db = openBus(bus)
  try {
    const admitted = latestAdmissionOf(contract, db, card.id)
    if (admitted === null)
      return undefined
    const admittedLine = admittedCardLine(contract, db, card.id, admitted)
    if (admittedLine !== undefined && !sameCard(admittedLine, card))
      return { kind: 'refused', reason: `card #${card.id} was admitted in the bus ${bus} as a different card (${admittedLine}) by ${admitted.dedupe_key}: admit the current card through ${ADMIT_COMMAND}, or pass ${withoutIntake} "<reason>" to record an exception` }
    const body = cardBodyAdmissionOf(db, card.id)
    return { kind: 'admitted', by: 'bus', event: admitted.dedupe_key, ts: admitted.ts, ...(body === null ? {} : { body }) }
  }
  finally {
    db.close()
  }
}

function admission(contract: TaskStartContract, bus: string, card: Card, waiver: string | undefined, withoutIntake: string): Admission {
  if (waiver !== undefined)
    return { kind: 'admitted', by: 'waiver', flag: withoutIntake, reason: waiver }
  return busAdmission(contract, bus, card, withoutIntake) ?? { kind: 'refused', reason: `card #${card.id} has no ${CARD_ADMITTED} in the bus ${bus}: it was not admitted; admit it through ${ADMIT_COMMAND}, or pass ${withoutIntake} "<reason>" to record an exception` }
}

function admissionRecord(admitted: Exclude<Admission, { kind: 'refused' }>): Record<string, string> {
  switch (admitted.by) {
    case 'bus':
      return { by: 'bus', event: admitted.event, admitted: admitted.ts }
    case 'waiver':
      return { by: 'waiver', flag: admitted.flag, reason: admitted.reason }
  }
}

type StartWrite = { kind: 'written' } | { kind: 'launch-owns-it' }

function recordStart(contract: TaskStartContract, bus: string, event: BusEvent): StartWrite {
  const db = openBus(bus)
  try {
    return inTransaction(db, (): StartWrite => {
      if (launchLeased(contract, db, event.cardId))
        return { kind: 'launch-owns-it' }
      appendEvent(db, event)
      return { kind: 'written' }
    })
  }
  finally {
    db.close()
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/

function baseOf(deps: TaskStartDeps, worktree: string): { base?: string } {
  try {
    const head = deps.git(worktree, ['rev-parse', 'HEAD']).trim()
    return FULL_SHA.test(head) ? { base: head } : {}
  }
  catch {
    return {}
  }
}

export function refuse(message: string): TaskStartResult {
  return { stdout: [], stderr: [`${PREFIX}${message}`], exitCode: 1 }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
}

export function flagValue(argv: string[], flag: string): { at: number, value: string | undefined } {
  const at = argv.indexOf(flag)
  return { at, value: at === -1 ? undefined : argv[at + 1] }
}

function pathFlagMissing(flag: { at: number, value: string | undefined }): boolean {
  return flag.at !== -1 && (flag.value === undefined || flag.value.startsWith('-'))
}

function cardArgs(argv: string[], flags: TaskStartFlags): { branch: string, card: string, waiver: string | undefined, adopt: string | undefined } | null {
  const card = flagValue(argv, flags.card)
  const waiver = flagValue(argv, flags.withoutIntake)
  const adopt = flagValue(argv, flags.adopt)
  if (card.value === undefined || (waiver.at !== -1 && (waiver.value === undefined || waiver.value.trim() === '')))
    return null
  if (pathFlagMissing(adopt))
    return null
  const taken = new Set([card, waiver, adopt].flatMap(flag => flag.at === -1 ? [] : [flag.at, flag.at + 1]))
  const positional = argv.filter((_, index) => !taken.has(index))
  return positional.length === 1 ? { branch: positional[0]!, card: card.value, waiver: waiver.value?.trim(), adopt: adopt.value } : null
}

type Contract = Pick<Signal, 'CONTRACT' | 'EXPECT'>

export interface HandedContract extends Contract {
  forecast?: CheapForecast
}

type RecordedForecast
  = | { tokens: number, minutes: number, class: string, n: number }
    | { kind: 'none', class: string, n: number }

function recordedForecast(forecast: CheapForecast): RecordedForecast {
  return forecast.kind === 'none'
    ? { kind: 'none', class: forecast.taskClass, n: forecast.n }
    : { tokens: forecast.tokens, minutes: forecast.minutes, class: forecast.taskClass, n: forecast.n }
}

type CardFile
  = | { kind: 'missing' }
    | { kind: 'refused', reason: string }
    | { kind: 'other', message: string }
    | { kind: 'parked', parked: ParkedTask, text: string }

function readCardBody(deps: TaskStartDeps, card: Card): CardFile {
  if (deps.cardBody === undefined)
    return { kind: 'missing' }
  let text: string | null
  try {
    text = deps.cardBody(card.id)
  }
  catch (error) {
    return { kind: 'refused', reason: `the card body of #${card.id} in the bus ${deps.bus} could not be read: ${firstLine(error)}` }
  }
  if (text === null)
    return { kind: 'missing' }
  const parsed = parseParkingFile(`${card.id}.md`, text)
  if (parsed.kind === 'refused')
    return parsed
  if (cardLine(parsed.parked.task.card) !== cardLine(card))
    return { kind: 'other', message: `the card body of #${card.id} in the bus ${deps.bus} carries card ${cardLine(parsed.parked.task.card)}, not the card given; nothing written` }
  return { ...parsed, text }
}

function admittedBody(recorded: string, text: string): boolean {
  return recorded === bodySha(text) || recorded === bodyShaWithoutTouches(text)
}

function editedPastAdmission(admitted: Exclude<Admission, { kind: 'refused' }>, cardFile: CardFile, card: Card, withoutIntake: string): string | null {
  if (admitted.by !== 'bus' || admitted.body === undefined || cardFile.kind !== 'parked' || admittedBody(admitted.body.bodySha, cardFile.text))
    return null
  return `the card body of #${card.id} is not the body ${admitted.body.event} admitted (bodySha ${admitted.body.bodySha}, the bus holds ${bodySha(cardFile.text)}): it was edited past intake; admit it again through ${ADMIT_COMMAND}, or pass ${withoutIntake} "<reason>" to record an exception; nothing written`
}

function manualContract(card: Card, cardFile: CardFile): Contract | string {
  const expect = `expect not recorded on the start line: its session is the window's ${SESSION_VARIABLE}, shared by every task the window runs, so no session is this task's alone`
  const contractOf = (touches: string) => ({ CONTRACT: `${cardTerms(card)} · touches ${touches} · law not recorded on the card`, EXPECT: expect })
  switch (cardFile.kind) {
    case 'missing':
      return contractOf(`not recorded on the card: no card body for #${card.id} in the bus`)
    case 'refused':
      return contractOf(`not recorded on the card: ${cardFile.reason}`)
    case 'other':
      return cardFile.message
    case 'parked':
      return contractOf(cardFile.parked.task.touches.join(', '))
  }
}

interface WrittenRisk {
  level?: string
  text: string
}

function riskAsWritten(body: string): WrittenRisk | undefined {
  const line = body.split('\n').find(row => row.startsWith(RISK_PREFIX))
  if (line === undefined)
    return undefined
  const text = line.slice(RISK_PREFIX.length)
  const level = RISK_LEVELS.find(candidate => text.startsWith(`${candidate} `))
  return level === undefined ? { text } : { level, text }
}

function whoAndRisk(cardFile: CardFile): { who?: string, risk?: WrittenRisk } {
  if (cardFile.kind !== 'parked')
    return {}
  const risk = riskAsWritten(cardFile.parked.task.body)
  return { who: cardFile.parked.who, ...(risk === undefined ? {} : { risk }) }
}

export function runTaskStart(argv: string[], deps: TaskStartDeps, handed?: HandedContract): TaskStartResult {
  const { flags } = deps
  if (!argv.includes(flags.card))
    return refuse(`a task starts from its card now: ${USAGE}; the id is the card's #<id>`)
  const args = cardArgs(argv, flags)
  if (args === null)
    return refuse(argv.includes(flags.adopt) ? ADOPT_USAGE : USAGE)
  const { branch } = args
  const parsed = parseCard(args.card, readMilestones(deps.cwd))
  if (parsed.kind === 'refused')
    return refuse(`card refused: ${parsed.reason}; nothing written`)
  const { card } = parsed
  const id = String(card.id)
  if (!SAFE_BRANCH.test(branch))
    return refuse(`branch '${branch}' must not be empty, hold whitespace or start with '-'`)
  const unsatisfied = unsatisfiedIn(deps.contract, deps.bus, card.depends)
  if (unsatisfied.length > 0)
    return refuse(`card #${id} depends on ${unsatisfied.map(dependency => `#${dependency}`).join(', ')}, which are not merged and not closed by a report; nothing written`)
  let admitted: Admission
  try {
    admitted = admission(deps.contract, deps.bus, card, args.waiver, flags.withoutIntake)
  }
  catch (error) {
    return refuse(`the bus ${deps.bus} could not be read: ${firstLine(error)}; nothing written`)
  }
  if (admitted.kind === 'refused')
    return refuse(`${admitted.reason}; nothing written`)
  const cardFile = readCardBody(deps, card)
  const atLimit = windowAtLimit(deps, id, cardFile)
  if (atLimit !== null)
    return refuse(atLimit)
  const edited = editedPastAdmission(admitted, cardFile, card, flags.withoutIntake)
  if (edited !== null)
    return refuse(edited)
  const contract = handed === undefined ? manualContract(card, cardFile) : { CONTRACT: handed.CONTRACT, EXPECT: handed.EXPECT }
  if (typeof contract === 'string')
    return refuse(contract)
  const ready = args.adopt === undefined ? cutTree(deps, id, branch) : adoptTree(deps, args.adopt, branch)
  if ('refused' in ready)
    return refuse(ready.refused)
  const { worktree } = ready
  const at = deps.now().toISOString()
  const start = { path: card.contour, started: at, ...(deps.session === undefined ? {} : { session: deps.session }), ...(deps.shift === undefined ? {} : { shift: deps.shift }), worktree, ...baseOf(deps, worktree), ...(ready.origin === undefined ? {} : { tree_origin: ready.origin }), ...(args.adopt === undefined ? {} : { adopts: worktree }), branch, card, ...whoAndRisk(cardFile), ...(handed?.forecast === undefined ? {} : { forecast: recordedForecast(handed.forecast) }), admission: admissionRecord(admitted) }
  const unsessioned = deps.session === undefined ? `; ${SESSION_VARIABLE} is not set, the board will show WINDOW UNKNOWN (no session)` : ''
  const entry = { ...contract, ACTION: `task:start ${branch} #${id}: ${ready.how}; ${CARD_STARTED} written to ${deps.bus}${unsessioned}`, RESULT: ENTRY_RESULT }
  const event: BusEvent = { ts: at, type: CARD_STARTED, actor: `${STARTER_ACTOR}${deps.session ?? STARTER_SESSION_BY_HAND}`, cardId: card.id, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${id}:${branch}:${at}`, payload: { ...start, entry: { schema: ENTRY_SCHEMA, ...entry } }, legacy: false }
  let written: StartWrite
  try {
    written = recordStart(deps.contract, deps.bus, event)
  }
  catch (error) {
    return refuse(`${ready.failedAppend} but ${CARD_STARTED} could not be written to the bus ${deps.bus}: ${firstLine(error)}`)
  }
  const signal = written.kind === 'written'
    ? entry
    : { ...entry, ACTION: `task:start ${branch} #${id}: ${ready.how}; ${CARD_STARTED} is the launch worker's, which holds the launch of #${id}${unsessioned}` }
  const stdout = [...renderSignal(`task:start #${id} ${card.name}`, signal, deps.style ?? PLAIN_STYLE), ...(ready.origin === undefined ? [] : [treeOriginLine(ready.origin)])]
  return { stdout, stderr: [], exitCode: 0, worktree }
}

export function gitIn(cwd: string, args: string[]): string {
  try {
    return processGit.read(cwd, args)
  }
  catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    throw stderr === '' ? error : new Error(stderr)
  }
}

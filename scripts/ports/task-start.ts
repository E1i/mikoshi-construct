import type { DatabaseSync } from 'node:sqlite'
import type { Card } from '../../src/card/grammar.js'
import type { ParkedTask } from '../../src/card/parking.js'
import type { CheapForecast } from '../../src/commands/cost/index.js'
import type { Signal, SignalStyle } from '../../src/ui/signal.js'
import type { BusEvent } from '../core/db.js'
import type { CardBodyReader } from '../intake/parking-reads.js'
import type { BodyAdmission } from '../core/queue.js'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { mergedFromBus } from '../../src/card/closed.js'
import { cardLine, cardTerms, parseCard } from '../../src/card/grammar.js'
import { parseParkingFile } from '../../src/card/parking.js'
import { RISK_LEVELS, RISK_PREFIX } from '../../src/card/risk.js'
import { bodySha, bodyShaWithoutTouches } from '../../src/commands/intake/confirm.js'
import { readMilestones } from '../../src/manifest.js'
import { PLAIN_STYLE, renderSignal, terminalStyle } from '../../src/ui/signal.js'
import { NOT_A_BACKFILL } from '../core/backfill-source.js'
import { appendEvent, defaultBusPath, inTransaction, openBus } from '../core/db.js'
import { busCardBodies } from '../intake/parking-reads.js'
import { cardBodyAdmissionOf, LEASED } from '../core/queue.js'
import { slotsOf, slotsVariable } from '../supervisor/scheduler.js'
import { STARTER_ACTOR, windowOpenPrs } from '../window/window-prs.js'
import { CARD_ADMITTED, CARD_STARTED } from '../core/events.js'
import { worktreeHome } from './worktree-home.js'
import { adoptTree, cutTree, pnpmInstall } from './worktree.js'
import { ENTRY_RESULT, ENTRY_SCHEMA } from '../core/entry.js'
import { busHistory } from '../core/journal.js'
import { busCardStates } from '../core/tasks.js'

export const PREFIX = '[task:start] '
export const USAGE = 'usage: pnpm task:start <branch> --card "<card>" [--without-intake "<reason>"]'
const CARD_FLAG = '--card'
const ADOPT_FLAG = '--adopt'
export const ADOPT_USAGE = 'usage: pnpm task:start <branch> --card "<card>" --adopt <tree> [--without-intake "<reason>"]'
const WITHOUT_INTAKE_FLAG = '--without-intake'
const SESSION_VARIABLE = 'CLAUDE_CODE_SESSION_ID'
const SAFE_BRANCH = /^[^\s-]\S*$/

export interface TaskStartDeps {
  cwd: string
  git: (cwd: string, args: string[]) => string
  install: (cwd: string, args: string[]) => void
  exists: (target: string) => boolean
  bus: string
  now: () => Date
  session: string | undefined
  shift?: string
  worktreeHome?: string
  style?: SignalStyle
  cardBody?: CardBodyReader
  windowLimit?: () => number
}

const WINDOW_LIMIT_SLOTS = 'review'

export interface TaskStartResult {
  stdout: string[]
  stderr: string[]
  exitCode: number
  worktree?: string
}

type Admission
  = | { kind: 'admitted', by: 'bus', event: string, ts: string, body?: BodyAdmission }
    | { kind: 'admitted', by: 'waiver', reason: string }
    | { kind: 'refused', reason: string }

const LATEST_ADMISSION = `SELECT ts, dedupe_key, payload FROM events WHERE type = '${CARD_ADMITTED}' AND legacy = 0 AND card_id = ? AND ${NOT_A_BACKFILL} ORDER BY id DESC LIMIT 1`
const ADMISSION_SOURCES = `
  SELECT source.payload FROM events admitted
  JOIN events source ON source.legacy = 1 AND source.dedupe_key = json_extract(admitted.payload, '$.admission')
  WHERE admitted.type = '${CARD_ADMITTED}' AND admitted.legacy = 0 AND admitted.card_id = ?
  ORDER BY admitted.id DESC
`
interface AdmittedRow { ts: string, dedupe_key: string, payload: string }

const LAUNCH_LEASE = `SELECT 1 FROM tasks WHERE queue = 'launch' AND state = '${LEASED}' AND card_id = ?`
const STARTER_SESSION_BY_HAND = 'by-hand'

function heldByWindow(bus: string): number[] {
  const db = openBus(bus)
  try {
    return windowOpenPrs(db).map(open => open.pr)
  }
  finally {
    db.close()
  }
}

function windowAtLimit(deps: TaskStartDeps, id: string): string | null {
  if (deps.windowLimit === undefined)
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

const ADMIT_COMMAND = 'pnpm intake --admit'

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

function admittedCardLine(db: DatabaseSync, id: number, latest: AdmittedRow): string | undefined {
  const own = stringField(latest.payload, 'card')
  if (own !== undefined)
    return own
  const sources = db.prepare(ADMISSION_SOURCES).all(id) as { payload: string }[]
  return sources.map(source => stringField(source.payload, 'card')).find(line => line !== undefined)
}

function busAdmission(bus: string, card: Card): Admission | undefined {
  const db = openBus(bus)
  try {
    const admitted = db.prepare(LATEST_ADMISSION).get(card.id) as AdmittedRow | undefined
    if (admitted === undefined)
      return undefined
    const admittedLine = admittedCardLine(db, card.id, admitted)
    if (admittedLine !== undefined && !sameCard(admittedLine, card))
      return { kind: 'refused', reason: `card #${card.id} was admitted in the bus ${bus} as a different card (${admittedLine}) by ${admitted.dedupe_key}: admit the current card through ${ADMIT_COMMAND}, or pass ${WITHOUT_INTAKE_FLAG} "<reason>" to record an exception` }
    const body = cardBodyAdmissionOf(db, card.id)
    return { kind: 'admitted', by: 'bus', event: admitted.dedupe_key, ts: admitted.ts, ...(body === null ? {} : { body }) }
  }
  finally {
    db.close()
  }
}

function admission(bus: string, card: Card, waiver: string | undefined): Admission {
  if (waiver !== undefined)
    return { kind: 'admitted', by: 'waiver', reason: waiver }
  return busAdmission(bus, card) ?? { kind: 'refused', reason: `card #${card.id} has no ${CARD_ADMITTED} in the bus ${bus}: it was not admitted; admit it through ${ADMIT_COMMAND}, or pass ${WITHOUT_INTAKE_FLAG} "<reason>" to record an exception` }
}

function admissionRecord(admitted: Exclude<Admission, { kind: 'refused' }>): Record<string, string> {
  switch (admitted.by) {
    case 'bus':
      return { by: 'bus', event: admitted.event, admitted: admitted.ts }
    case 'waiver':
      return { by: 'waiver', flag: WITHOUT_INTAKE_FLAG, reason: admitted.reason }
  }
}

type StartWrite = { kind: 'written' } | { kind: 'launch-owns-it' }

function recordStart(bus: string, event: BusEvent): StartWrite {
  const db = openBus(bus)
  try {
    return inTransaction(db, (): StartWrite => {
      if (db.prepare(LAUNCH_LEASE).get(event.cardId) !== undefined)
        return { kind: 'launch-owns-it' }
      appendEvent(db, event)
      return { kind: 'written' }
    })
  }
  finally {
    db.close()
  }
}

function refuse(message: string): TaskStartResult {
  return { stdout: [], stderr: [`${PREFIX}${message}`], exitCode: 1 }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!
}

function flagValue(argv: string[], flag: string): { at: number, value: string | undefined } {
  const at = argv.indexOf(flag)
  return { at, value: at === -1 ? undefined : argv[at + 1] }
}

function pathFlagMissing(flag: { at: number, value: string | undefined }): boolean {
  return flag.at !== -1 && (flag.value === undefined || flag.value.startsWith('-'))
}

function cardArgs(argv: string[]): { branch: string, card: string, waiver: string | undefined, adopt: string | undefined } | null {
  const card = flagValue(argv, CARD_FLAG)
  const waiver = flagValue(argv, WITHOUT_INTAKE_FLAG)
  const adopt = flagValue(argv, ADOPT_FLAG)
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

function editedPastAdmission(admitted: Exclude<Admission, { kind: 'refused' }>, cardFile: CardFile, card: Card): string | null {
  if (admitted.by !== 'bus' || admitted.body === undefined || cardFile.kind !== 'parked' || admittedBody(admitted.body.bodySha, cardFile.text))
    return null
  return `the card body of #${card.id} is not the body ${admitted.body.event} admitted (bodySha ${admitted.body.bodySha}, the bus holds ${bodySha(cardFile.text)}): it was edited past intake; admit it again through ${ADMIT_COMMAND}, or pass ${WITHOUT_INTAKE_FLAG} "<reason>" to record an exception; nothing written`
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
  if (!argv.includes(CARD_FLAG))
    return refuse(`a task starts from its card now: ${USAGE}; the id is the card's #<id>`)
  const args = cardArgs(argv)
  if (args === null)
    return refuse(argv.includes(ADOPT_FLAG) ? ADOPT_USAGE : USAGE)
  const { branch } = args
  const parsed = parseCard(args.card, readMilestones(deps.cwd))
  if (parsed.kind === 'refused')
    return refuse(`card refused: ${parsed.reason}; nothing written`)
  const { card } = parsed
  const id = String(card.id)
  if (!SAFE_BRANCH.test(branch))
    return refuse(`branch '${branch}' must not be empty, hold whitespace or start with '-'`)
  const merged = mergedFromBus(busHistory(deps.bus), busCardStates(deps.bus))
  const unmerged = card.depends.filter(dependency => !merged.has(String(dependency)))
  if (unmerged.length > 0)
    return refuse(`card #${id} depends on ${unmerged.map(dependency => `#${dependency}`).join(', ')}, which are not merged; nothing written`)
  let admitted: Admission
  try {
    admitted = admission(deps.bus, card, args.waiver)
  }
  catch (error) {
    return refuse(`the bus ${deps.bus} could not be read: ${firstLine(error)}; nothing written`)
  }
  if (admitted.kind === 'refused')
    return refuse(`${admitted.reason}; nothing written`)
  const atLimit = windowAtLimit(deps, id)
  if (atLimit !== null)
    return refuse(atLimit)
  const cardFile = readCardBody(deps, card)
  const edited = editedPastAdmission(admitted, cardFile, card)
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
  const start = { path: card.contour, started: at, ...(deps.session === undefined ? {} : { session: deps.session }), ...(deps.shift === undefined ? {} : { shift: deps.shift }), worktree, ...(args.adopt === undefined ? {} : { adopts: worktree }), branch, card, ...whoAndRisk(cardFile), ...(handed?.forecast === undefined ? {} : { forecast: recordedForecast(handed.forecast) }), admission: admissionRecord(admitted) }
  const unsessioned = deps.session === undefined ? `; ${SESSION_VARIABLE} is not set, the board will show WINDOW UNKNOWN (no session)` : ''
  const entry = { ...contract, ACTION: `task:start ${branch} #${id}: ${ready.how}; ${CARD_STARTED} written to ${deps.bus}${unsessioned}`, RESULT: ENTRY_RESULT }
  const event: BusEvent = { ts: at, type: CARD_STARTED, actor: `${STARTER_ACTOR}${deps.session ?? STARTER_SESSION_BY_HAND}`, cardId: card.id, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${id}:${branch}:${at}`, payload: { ...start, entry: { schema: ENTRY_SCHEMA, ...entry } }, legacy: false }
  let written: StartWrite
  try {
    written = recordStart(deps.bus, event)
  }
  catch (error) {
    return refuse(`${ready.failedAppend} but ${CARD_STARTED} could not be written to the bus ${deps.bus}: ${firstLine(error)}`)
  }
  const signal = written.kind === 'written'
    ? entry
    : { ...entry, ACTION: `task:start ${branch} #${id}: ${ready.how}; ${CARD_STARTED} is the launch worker's, which holds the launch of #${id}${unsessioned}` }
  const stdout = renderSignal(`task:start #${id} ${card.name}`, signal, deps.style ?? PLAIN_STYLE)
  return { stdout, stderr: [], exitCode: 0, worktree }
}

export function gitIn(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    throw stderr === '' ? error : new Error(stderr)
  }
}

function realDeps(): TaskStartDeps {
  return {
    cwd: process.cwd(),
    git: gitIn,
    install: pnpmInstall,
    exists: existsSync,
    bus: defaultBusPath(),
    now: () => new Date(),
    session: process.env[SESSION_VARIABLE] === '' ? undefined : process.env[SESSION_VARIABLE],
    worktreeHome: worktreeHome(process.env),
    cardBody: busCardBodies(defaultBusPath()),
    style: terminalStyle(process.stdout.isTTY, process.env.NO_COLOR),
    windowLimit: () => slotsOf(WINDOW_LIMIT_SLOTS, process.env),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runTaskStart(process.argv.slice(2), realDeps())
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  process.exitCode = result.exitCode
}

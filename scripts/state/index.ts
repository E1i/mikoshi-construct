import type { Buffer } from 'node:buffer'
import type { ParkedTask } from '../../src/card/parking.js'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { decisionsRefusals, inForce, parseDecisions, spendDecisions } from '../decisions/decisions.js'
import { parkedDepends, RETIRED_PARKING } from '../ghosts/handoff-check.js'
import { runHandoffWrite } from '../shift/handoff-write.js'
import { GHOST_JOURNAL } from '../shift/places.js'

export const PREFIX = '[state] '
export const SCHEMA_VERSION = 1
export const VIEWS = ['decisions', 'queue', 'inflight'] as const
export const WRITES = ['note', 'decision', 'card', 'handoff'] as const
export const STATE_EVENT = 'state'
export const NOTE_EVENT = 'note'
export const CONSTRUCT_HOME_VARIABLE = 'CONSTRUCT_HOME'
export const USAGE = `usage: pnpm state <${VIEWS.join('|')}> | pnpm state:note <task> <text> | pnpm state:decision <text> [--cards #A #B] | pnpm state:card <lane>/<id>.md <draft.md> | pnpm state:handoff <handoff.md> <draft.md>`

const LOCK_POLL_MS = 25
const LOCK_TIMEOUT_MS = 30_000
const CARD_TARGET = /^(?:[\w.-]+\/)?(\d+)\.md$/
const CARD_REF = /^#?([1-9]\d*)$/

export type View = typeof VIEWS[number]
export type Write = typeof WRITES[number]

export interface StatePlaces {
  home: string
  journal: string
  decisions: string
  parking: string
  projections: string
  lock: string
}

export interface Fingerprint {
  journalOffset: number
  sources: string
}

export interface FastCheck {
  journalSize: number
  newestMtimeMs: number
  files: number
}

export interface Projection {
  schema: number
  view: View
  fingerprint: Fingerprint
  fast: FastCheck
  lines: string[]
  seal: string
}

export interface ViewReading {
  lines: string[]
  rebuilt: boolean
}

export interface StateDeps {
  places: StatePlaces
  cwd: string
  now: () => Date
  pid: number
  alive: (pid: number) => boolean
  out: (line: string) => void
  err: (line: string) => void
}

export function statePlaces(home: string, handoffDir?: string): StatePlaces {
  const projections = path.join(home, 'state')
  return {
    home,
    journal: path.join(handoffDir ?? path.join(home, 'handoff'), GHOST_JOURNAL),
    decisions: path.join(home, 'owner-decisions.md'),
    parking: path.join(home, 'parking'),
    projections,
    lock: path.join(projections, 'write.lock'),
  }
}

export function constructHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[CONSTRUCT_HOME_VARIABLE] ?? path.join(os.homedir(), '.construct')
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  }
  catch {
    return null
  }
}

function writeAtomically(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const staged = `${file}.${process.pid}.tmp`
  writeFileSync(staged, text)
  renameSync(staged, file)
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function createExclusive(file: string, text: string): boolean {
  try {
    writeFileSync(file, text, { flag: 'wx' })
    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return false
    throw error
  }
}

function liveHolder(file: string, deps: Pick<StateDeps, 'pid' | 'alive'>): number | null {
  const pid = Number(readOrNull(file)?.trim())
  return Number.isInteger(pid) && pid > 0 && pid !== deps.pid && deps.alive(pid) ? pid : null
}

function tryLock(lock: string, deps: Pick<StateDeps, 'pid' | 'alive'>): boolean {
  const own = `${deps.pid}\n`
  if (createExclusive(lock, own))
    return true
  if (liveHolder(lock, deps) !== null)
    return false
  const takeover = `${lock}.takeover`
  if (!createExclusive(takeover, own)) {
    if (liveHolder(takeover, deps) === null)
      rmSync(takeover, { force: true })
    return false
  }
  try {
    if (liveHolder(lock, deps) !== null)
      return false
    writeFileSync(lock, own)
    return true
  }
  finally {
    rmSync(takeover, { force: true })
  }
}

export function withStateLock<T>(places: StatePlaces, deps: Pick<StateDeps, 'pid' | 'alive'>, task: () => T): T {
  mkdirSync(path.dirname(places.lock), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (!tryLock(places.lock, deps)) {
    if (Date.now() > deadline)
      throw new Error(`${PREFIX}${places.lock} held by pid ${readOrNull(places.lock)?.trim()} past ${LOCK_TIMEOUT_MS} ms`)
    sleep(LOCK_POLL_MS)
  }
  try {
    return task()
  }
  finally {
    rmSync(places.lock, { force: true })
  }
}

function appendEvent(places: StatePlaces, event: object): void {
  mkdirSync(path.dirname(places.journal), { recursive: true })
  appendFileSync(places.journal, `${JSON.stringify(event)}\n`)
}

function stateEvent(places: StatePlaces, deps: StateDeps, write: Write, file: string, extra: object): void {
  appendEvent(places, { event: STATE_EVENT, write, file, sha256: sha256(readFileSync(file)), ...extra, ts: deps.now().toISOString() })
}

type Outcome = { ok: true, line: string } | { ok: false, lines: string[] }

function writeNote(args: string[], deps: StateDeps): Outcome {
  const [task, ...words] = args
  if (task === undefined || words.length === 0)
    return { ok: false, lines: [USAGE] }
  appendEvent(deps.places, { event: NOTE_EVENT, task, note: words.join(' '), by: 'state:note', ts: deps.now().toISOString() })
  return { ok: true, line: `note on ${task} in ${deps.places.journal}` }
}

function parseDecisionArgs(args: string[]): { text: string, cards: number[] } | null {
  const at = args.indexOf('--cards')
  const words = at === -1 ? args : args.slice(0, at)
  const refs = at === -1 ? [] : args.slice(at + 1)
  const cards = refs.map(ref => CARD_REF.exec(ref)?.[1])
  if (words.length === 0 || (at !== -1 && refs.length === 0) || cards.includes(undefined))
    return null
  return { text: words.join(' ').trim(), cards: cards.map(Number) }
}

function writeDecision(args: string[], deps: StateDeps): Outcome {
  const parsed = parseDecisionArgs(args)
  if (parsed === null)
    return { ok: false, lines: [USAGE] }
  const file = deps.places.decisions
  const before = readOrNull(file)
  if (before === null)
    return { ok: false, lines: [`no decisions at ${file}`] }
  const number = Math.max(0, ...parseDecisions(before).decisions.map(decision => decision.number)) + 1
  const cards = parsed.cards.length === 0 ? '' : ` · card ${parsed.cards.map(card => `#${card}`).join(' ')}`
  const line = `- D-${number} · ${deps.now().toISOString().slice(0, 10)} — ${parsed.text}${cards}`
  const after = `${before.endsWith('\n') || before === '' ? before : `${before}\n`}${line}\n`
  const refusals = decisionsRefusals(after)
  if (refusals.length > 0)
    return { ok: false, lines: [...refusals, `${file} unchanged`] }
  writeAtomically(file, after)
  stateEvent(deps.places, deps, 'decision', file, { decision: number })
  return { ok: true, line: `D-${number} in ${file}` }
}

function writeCard(args: string[], deps: StateDeps): Outcome {
  const [target, draft] = args
  const id = target === undefined ? undefined : CARD_TARGET.exec(target)?.[1]
  if (id === undefined || draft === undefined || args.length !== 2)
    return { ok: false, lines: [USAGE] }
  const text = readOrNull(path.resolve(deps.cwd, draft))
  if (text === null)
    return { ok: false, lines: [`no draft at ${path.resolve(deps.cwd, draft)}`] }
  const parsed = parseParkingFile(`${id}.md`, text)
  if (parsed.kind === 'refused')
    return { ok: false, lines: [parsed.reason] }
  const file = path.join(deps.places.parking, target!)
  writeAtomically(file, text)
  stateEvent(deps.places, deps, 'card', file, { card: Number(id) })
  return { ok: true, line: `#${id} in ${file}` }
}

function writeHandoff(args: string[], deps: StateDeps): Outcome {
  const lines: string[] = []
  const code = runHandoffWrite(args.includes('--parking') ? args : [...args, '--parking', deps.places.parking], {
    cwd: deps.cwd,
    handoffDir: path.dirname(deps.places.journal),
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    listDir: readdirSync,
    makeDir: dir => mkdirSync(dir, { recursive: true }),
    write: (file, text) => writeFileSync(file, text),
    writeNew: (file, text) => writeFileSync(file, text, { flag: 'wx' }),
    rename: renameSync,
    parked: parkedDepends,
    home: os.homedir(),
    out: line => lines.push(line),
    err: line => lines.push(line),
  })
  if (code !== 0)
    return { ok: false, lines }
  const handoff = path.resolve(path.dirname(deps.places.journal), args[0]!)
  stateEvent(deps.places, deps, 'handoff', handoff, {})
  return { ok: true, line: lines.join('\n') }
}

const WRITERS: Record<Write, (args: string[], deps: StateDeps) => Outcome> = {
  note: writeNote,
  decision: writeDecision,
  card: writeCard,
  handoff: writeHandoff,
}

interface JournalLine {
  event?: unknown
  task?: unknown
  path?: unknown
  started?: unknown
  branch?: unknown
  report?: unknown
  verification?: unknown
  write?: unknown
  file?: unknown
  sha256?: unknown
  ts?: unknown
}

function journalLines(text: string): JournalLine[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as unknown
      return typeof entry === 'object' && entry !== null ? [entry as JournalLine] : []
    }
    catch {
      return []
    }
  })
}

function settledTasks(lines: readonly JournalLine[]): Set<string> {
  return new Set(lines
    .filter(line => line.event === 'merge' || (line.event === 'path' && (line.report !== undefined || line.verification !== undefined)))
    .flatMap(line => typeof line.task === 'string' ? [line.task] : []))
}

function inflightLines(lines: readonly JournalLine[]): string[] {
  const settled = settledTasks(lines)
  const started = new Map<string, JournalLine>()
  for (const line of lines) {
    if (line.event === 'path' && typeof line.task === 'string' && typeof line.started === 'string')
      started.set(line.task, line)
  }
  return [...started.values()]
    .filter(line => !settled.has(line.task as string))
    .map(line => `#${String(line.task)} ${String(line.path)} since ${String(line.started)}${typeof line.branch === 'string' ? ` · ${line.branch}` : ''}`)
}

function parkingFiles(parking: string): string[] {
  const files: string[] = []
  const visit = (dir: string, nested: boolean): void => {
    for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!nested && !(RETIRED_PARKING as readonly string[]).includes(entry.name))
          visit(file, true)
      }
      else if (/^\d+\.md$/.test(entry.name)) {
        files.push(file)
      }
    }
  }
  visit(parking, false)
  return files.sort()
}

function queueLines(places: StatePlaces, lines: readonly JournalLine[]): string[] {
  const settled = settledTasks(lines)
  const inflight = new Set(inflightLines(lines).map(line => line.slice(1, line.indexOf(' '))))
  const parked = new Map<number, ParkedTask>()
  for (const file of parkingFiles(places.parking)) {
    const parsed = parseParkingFile(path.basename(file), readFileSync(file, 'utf8'))
    if (parsed.kind === 'parked' && !parked.has(parsed.parked.task.card.id))
      parked.set(parsed.parked.task.card.id, parsed.parked)
  }
  return [...parked.values()]
    .filter(card => !settled.has(String(card.task.card.id)) && !inflight.has(String(card.task.card.id)))
    .sort((a, b) => Number(b.priority !== null) - Number(a.priority !== null) || a.task.card.id - b.task.card.id)
    .map(parked => `${parked.task.card.line} · who: ${parked.who}${parked.priority === null ? '' : ` · ${parked.priority}`}`)
}

function decisionLines(places: StatePlaces, lines: readonly JournalLine[]): string[] {
  const text = readOrNull(places.decisions)
  if (text === null)
    return [`no decisions at ${places.decisions}`]
  const settled = settledTasks(lines)
  const spent = spendDecisions(text, card => settled.has(String(card)))
  const refusals = decisionsRefusals(spent)
  return refusals.length > 0 ? refusals : inForce(parseDecisions(spent).decisions).map(decision => decision.text)
}

export function viewSources(view: View, places: StatePlaces): string[] {
  if (view === 'decisions')
    return [places.decisions]
  if (view === 'queue')
    return parkingFiles(places.parking)
  return []
}

export function buildView(view: View, places: StatePlaces): string[] {
  const lines = journalLines(readOrNull(places.journal) ?? '')
  if (view === 'decisions')
    return decisionLines(places, lines)
  if (view === 'queue')
    return queueLines(places, lines)
  return inflightLines(lines)
}

function sizeOf(file: string): number {
  return existsSync(file) ? statSync(file).size : 0
}

export function fingerprintOf(view: View, places: StatePlaces): Fingerprint {
  const sources = viewSources(view, places).map(file => `${path.relative(places.home, file)}\0${readOrNull(file) === null ? '-' : sha256(readFileSync(file))}`)
  return { journalOffset: sizeOf(places.journal), sources: sha256(sources.join('\n')) }
}

function fastCheckOf(view: View, places: StatePlaces): FastCheck {
  const files = viewSources(view, places).filter(existsSync)
  return {
    journalSize: sizeOf(places.journal),
    newestMtimeMs: Math.max(0, ...files.map(file => statSync(file).mtimeMs)),
    files: files.length,
  }
}

export function sealOf(projection: Omit<Projection, 'seal' | 'fast'>): string {
  return sha256(JSON.stringify([projection.schema, projection.view, projection.fingerprint, projection.lines]))
}

export function projectionPath(view: View, places: StatePlaces): string {
  return path.join(places.projections, `${view}.json`)
}

export function storedProjection(view: View, places: StatePlaces): Projection | null {
  const text = readOrNull(projectionPath(view, places))
  if (text === null)
    return null
  try {
    const stored = JSON.parse(text) as Projection
    return stored.schema === SCHEMA_VERSION && stored.view === view && Array.isArray(stored.lines) && stored.seal === sealOf(stored) ? stored : null
  }
  catch {
    return null
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function writeProjection(view: View, places: StatePlaces, fingerprint: Fingerprint, lines: string[]): void {
  const body = { schema: SCHEMA_VERSION, view, fingerprint, lines }
  writeAtomically(projectionPath(view, places), `${JSON.stringify({ ...body, fast: fastCheckOf(view, places), seal: sealOf(body) }, null, 2)}\n`)
}

export function readView(view: View, places: StatePlaces): ViewReading {
  const stored = storedProjection(view, places)
  if (stored !== null && sameJson(stored.fast, fastCheckOf(view, places)))
    return { lines: stored.lines, rebuilt: false }
  const fingerprint = fingerprintOf(view, places)
  if (stored !== null && sameJson(stored.fingerprint, fingerprint)) {
    writeProjection(view, places, fingerprint, stored.lines)
    return { lines: stored.lines, rebuilt: false }
  }
  const lines = buildView(view, places)
  writeProjection(view, places, fingerprint, lines)
  return { lines, rebuilt: true }
}

export function renderViews(places: StatePlaces): string {
  return VIEWS.map((view) => {
    const { lines } = readView(view, places)
    return [`## pnpm state ${view}`, ...(lines.length === 0 ? ['none'] : lines)].join('\n')
  }).join('\n\n')
}

function projectionFindings(places: StatePlaces): string[] {
  return VIEWS.flatMap((view) => {
    const file = projectionPath(view, places)
    if (!existsSync(file))
      return []
    const stored = storedProjection(view, places)
    if (stored === null)
      return [`${file}: damaged or of another schema; the next read rebuilds it`]
    if (!sameJson(stored.fingerprint, fingerprintOf(view, places)))
      return []
    return sameJson(stored.lines, buildView(view, places)) ? [] : [`${file}: differs from the ${view} view rebuilt from its source`]
  })
}

function bypassFindings(places: StatePlaces): string[] {
  const last = new Map<string, JournalLine>()
  for (const line of journalLines(readOrNull(places.journal) ?? '')) {
    if (line.event === STATE_EVENT && typeof line.file === 'string' && typeof line.sha256 === 'string')
      last.set(line.file, line)
  }
  return [...last.entries()].flatMap(([file, line]) => {
    const now = existsSync(file) ? sha256(readFileSync(file)) : null
    if (now === line.sha256)
      return []
    return [`${file}: ${now === null ? 'removed' : 'changed'} with no state:* event since the ${String(line.write)} at ${String(line.ts)}`]
  })
}

export function stateFindings(places: StatePlaces): string[] {
  return [...bypassFindings(places), ...projectionFindings(places)]
}

export function runState(args: string[], deps: StateDeps): number {
  const [verb, ...rest] = args
  if ((VIEWS as readonly string[]).includes(verb ?? '') && rest.length === 0) {
    for (const line of readView(verb as View, deps.places).lines)
      deps.out(line)
    return 0
  }
  if (!(WRITES as readonly string[]).includes(verb ?? '')) {
    deps.err(`${PREFIX}${USAGE}`)
    return 2
  }
  const outcome = withStateLock(deps.places, deps, () => WRITERS[verb as Write](rest, deps))
  if (!outcome.ok) {
    for (const line of outcome.lines)
      deps.err(`${PREFIX}${line}`)
    return 1
  }
  deps.out(`${PREFIX}${outcome.line}`)
  return 0
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function realStateDeps(): StateDeps {
  return {
    places: statePlaces(constructHome(), process.env[HANDOFF_DIR_VARIABLE]),
    cwd: process.cwd(),
    now: () => new Date(),
    pid: process.pid,
    alive: pidAlive,
    out: line => console.log(line),
    err: line => console.error(line),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runState(process.argv.slice(2), realStateDeps())

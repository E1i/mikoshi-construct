import type { WindowShard } from '../policy/shards.js'
import type { Board } from './board.js'
import type { ExitReadings, Reading } from './eddies-measure.js'
import type { ParkedDepends } from './handoff-check.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from '../core/db.js'
import { MERGE_DONE } from '../core/events.js'
import { handoffDirOf } from '../core/handoff-dir.js'
import { busParkedDepends } from '../intake/parking-reads.js'
import { activeDecisionsShard, VERSION_PR_RESERVATION } from '../policy/shards.js'
import { execGh, readGhJson } from '../ports/gh.js'
import { CARD_VARIABLE } from '../ports/session.js'
import { MERGE_PAST_THE_BUS, readBoard } from './board.js'
import { appended, archiveOfDay, DAY_FILE_LIMIT, dayBytes, dayFileNamedIn, splitDay } from './day-archive.js'
import { projectRoot, realExitReadings, UNKNOWN } from './eddies-measure.js'
import { stopReasonOf } from './exit.js'
import { BLOCKED_LABEL, handoffBytes, handoffRefusals, IN_FLIGHT_LABEL, labelsOf, NO_PREV, PREV_LABEL, STATE_LABELS } from './handoff-check.js'
import { HANDOFF_VARIABLE, MIKO_HANDOFF_NAME, statusOf } from './loop.js'
import { windowOf } from './window.js'

export const PREFIX = '[handoff:write] '
export const USAGE = 'usage: pnpm handoff:write <handoff.md> <draft.md>'
export const ARCHIVE_DIR = 'archive'
export const OWNER_BOUNDARIES = [VERSION_PR_RESERVATION, 'owner-merged-kind', 'missing-right', 'owner-question'] as const

const ARCHIVED = /^(\d{4,})\.md$/
const STOP_HEADING = /^#{1,6} +STOP\b/
const PREV_LINE = new RegExp(`^\\s*(?:[-*+]\\s+)?${PREV_LABEL}:`, 'i')
const NAMED_BOUNDARY = /\s—\s*boundary:\s*(\S+)\s*$/
export const STOP_ROLES = ['window', 'operator', 'card'] as const
const NOTHING = 'none'
const GENERATED_LABELS = ['merged today', 'windows', 'stop reason'] as const
const OWNER_WAIT_ENTRY = /^Q\d+ (?:open|answered)(?: PR #(\d+))?$/
const NEXT_TASK_FORM = /^(?:#\d+ \S.*|item \d+ of \S.*)$/
const POSITIVE_INTEGER = /^[1-9]\d*$/
const TITLE_OR_BLANK = /^(?:# .*|\s*)$/
const DRAFT_STOP_FIELDS = /^\s*(?:[-*+]\s+)?(?:role|session):/i
const WHOLE_READING = /\bread\b.+\bwhole\b/i
const DAY_ARCHIVE_NAME = /day-\d{4}-\d{2}-\d{2}\.archive\.md/
const NAMED_HEADING = / § \S/

export type HandoffState = Pick<Board, 'ready' | 'blocked' | 'lanes' | 'execution'>
export type StateReading = { kind: 'read', state: HandoffState } | { kind: 'unread', why: string }
export type MergedReading = { kind: 'read', cards: number[], merges: number, updates: number } | { kind: 'unread', why: string }
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED' | 'unread'

export interface HandoffWriteDeps {
  cwd: string
  handoffDir: string | undefined
  sessionHandoff: string | null
  exists: (file: string) => boolean
  read: (file: string) => string
  listDir: (dir: string) => string[]
  makeDir: (dir: string) => void
  write: (file: string, text: string) => void
  writeNew: (file: string, text: string) => void
  rename: (from: string, to: string) => void
  parked: () => ParkedDepends
  state: () => StateReading
  merged: (since: string) => MergedReading
  prState: (pr: number) => PrState
  decisionsShard: (now: Date) => WindowShard | null
  readings: () => ExitReadings
  stopReason: (status: string | null, readings: ExitReadings) => string | null
  now: () => Date
  home: string
  out: (line: string) => void
  err: (line: string) => void
}

function setOrNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value
}

export function sessionHandoffOf(env: NodeJS.ProcessEnv, home: string, dir: string = process.cwd()): string | null {
  if (setOrNull(env[CARD_VARIABLE]) !== null)
    return null
  return setOrNull(env[HANDOFF_VARIABLE]) ?? path.join(handoffDirOf(env, home, dir), MIKO_HANDOFF_NAME)
}

export function nextArchive(names: readonly string[]): string {
  const taken = names.flatMap(name => ARCHIVED.exec(name)?.[1] ?? []).map(Number)
  return `${String(Math.max(0, ...taken) + 1).padStart(4, '0')}.md`
}

export function withPrev(draft: string, prev: string): string {
  const lines = draft.split(/\r?\n/).filter(line => !PREV_LINE.test(line))
  const stop = lines.findIndex(line => STOP_HEADING.test(line))
  lines.splice(stop + 1, 0, `${PREV_LABEL}: ${prev}`)
  return lines.join('\n')
}

function joinedOrNothing(items: readonly string[], separator: string): string {
  return items.length === 0 ? NOTHING : items.join(separator)
}

function inFlightEntry(row: HandoffState['execution'][number]): string {
  const stage = row.stage.replace(/[\s,]+/g, '-')
  return `- #${row.card} ${stage}${row.pr === null ? '' : ` PR #${row.pr}`}`
}

export function stateLines(state: HandoffState): string[] {
  const current = state.lanes.filter(lane => lane.card !== null).map(lane => `#${lane.card} ${lane.lane} ${lane.state}`)
  const inFlight = state.execution.filter(row => !row.markers.includes(MERGE_PAST_THE_BUS))
  return [
    `current card: ${joinedOrNothing(current, '; ')}`,
    `queue: ${joinedOrNothing(state.ready.map(card => `#${card.card}`), ' → ')}`,
    ...(inFlight.length === 0 ? [`${IN_FLIGHT_LABEL}: ${NOTHING}`] : [`${IN_FLIGHT_LABEL}:`, ...inFlight.map(inFlightEntry)]),
    `${BLOCKED_LABEL}: ${joinedOrNothing(state.blocked.map(card => `#${card.card} ${card.reason}`), '; ')}`,
  ]
}

export function withState(draft: string, generated: readonly string[]): string {
  const lines = draft.split(/\r?\n/)
  const stop = lines.findIndex(line => STOP_HEADING.test(line))
  lines.splice(stop + 1, 0, ...generated)
  return lines.join('\n')
}

export function draftStateRefusals(draft: string): string[] {
  const labels = new Set(labelsOf(draft))
  return STATE_LABELS.filter(label => labels.has(label)).map(label => `${PREFIX}${label}: generated from the bus state; drop it from the draft, which carries the stop reason and the next task`)
}

function stateSource(reading: StateReading): string {
  const labels = STATE_LABELS.join(', ')
  return reading.kind === 'read' ? `${labels} from the bus state` : `${reading.why}: ${labels} as the draft wrote them`
}

function fieldLine(label: string): RegExp {
  return new RegExp(`^\\s*(?:[-*+]\\s+)?${label}:\\s*(.*)$`, 'i')
}

function fieldValue(text: string, label: string): string | null {
  const pattern = fieldLine(label)
  for (const line of text.split(/\r?\n/)) {
    const found = pattern.exec(line)
    if (found !== null)
      return found[1]!.trim()
  }
  return null
}

function withFieldValue(text: string, label: string, value: string): string {
  const pattern = fieldLine(label)
  return text.split(/\r?\n/).map(line => pattern.test(line) ? line.replace(/:.*$/, `: ${value}`) : line).join('\n')
}

function statusLineOf(text: string): string | undefined {
  return text.split(/\r?\n/).filter(line => statusOf(line) !== null).at(-1)
}

export function draftGeneratedRefusals(draft: string): string[] {
  const labels = new Set(labelsOf(draft))
  const role = fieldValue(draft, 'role') ?? ''
  const session = fieldValue(draft, 'session') ?? ''
  return [
    ...(draft.split(/\r?\n/).some(line => STOP_HEADING.test(line)) ? [`${PREFIX}STOP heading: generated from role: and session:; drop it from the draft`] : []),
    ...GENERATED_LABELS.filter(label => labels.has(label)).map(label => `${PREFIX}${label}: generated from the bus and the readings; drop it from the draft`),
    ...((STOP_ROLES as readonly string[]).includes(role) ? [] : [`${PREFIX}role: "${role.slice(0, 60)}" is not one of ${STOP_ROLES.join(', ')}`]),
    ...(POSITIVE_INTEGER.test(session) ? [] : [`${PREFIX}session: "${session.slice(0, 60)}" is not a positive integer`]),
  ]
}

export function nextTaskFormRefusals(draft: string): string[] {
  const value = fieldValue(draft, 'next task')
  const nothingToDo = value?.toLowerCase() === NOTHING && statusOf(statusLineOf(draft) ?? '') === 'DONE'
  return value === null || value === '' || nothingToDo || NEXT_TASK_FORM.test(value) ? [] : [`${PREFIX}next task: "${value.slice(0, 60)}" is not "#<card> <step>" or "item <N> of <list name>"`]
}

export function ownerWaits(draft: string, prState: (pr: number) => PrState): { refusals: string[], draft: string } {
  const value = fieldValue(draft, 'owner waits')
  if (value === null || value === '' || value === NOTHING)
    return { refusals: [], draft }
  const entries = value.split(';').map(entry => entry.trim())
  const malformed = entries.find(entry => !OWNER_WAIT_ENTRY.test(entry))
  if (malformed !== undefined)
    return { refusals: [`${PREFIX}owner waits: "${malformed.slice(0, 60)}" is not Q<N> open|answered [PR #M], entries joined by ;, or ${NOTHING}`], draft }
  const refusals: string[] = []
  const checked = entries.map((entry) => {
    const pr = OWNER_WAIT_ENTRY.exec(entry)?.[1]
    if (pr === undefined)
      return entry
    const state = prState(Number(pr))
    if (state === 'MERGED' || state === 'CLOSED')
      refusals.push(`${PREFIX}owner waits: PR #${pr} is ${state.toLowerCase()}; drop it`)
    return state === 'unread' ? `${entry} (PR #${pr} unread)` : entry
  })
  return { refusals, draft: withFieldValue(draft, 'owner waits', checked.join('; ')) }
}

function readingText(value: Reading<number>): string {
  return value === UNKNOWN ? 'unknown' : String(value)
}

export function stopReasonLine(reason: string | null, readings: ExitReadings): string {
  if (reason === null)
    return `stop reason: ${NOTHING}`
  return `stop reason: ${reason} (${readingText(readings.context)}/${readingText(readings.contextWarn)} tokens, ${readingText(readings.spent)}/${readingText(readings.spendWarn)} spend)`
}

export function mergedLines(merged: MergedReading): string[] {
  if (merged.kind === 'unread')
    return [`merged today: unread (${merged.why})`, 'windows: unread']
  return [`merged today: ${joinedOrNothing(merged.cards.map(card => `#${card}`), ', ')}`, `windows: merge ${merged.merges}, update ${merged.updates}`]
}

export function boundaryOf(draft: string, reason: string | null): string {
  const status = statusOf(draft)
  if (status === 'DONE')
    return 'done'
  if (status === 'OWNER')
    return NAMED_BOUNDARY.exec(statusLineOf(draft) ?? '')?.[1] ?? NOTHING
  return reason ?? NOTHING
}

export function withStop(draft: string, heading: string, generated: readonly string[]): string {
  const lines = draft.split(/\r?\n/).filter(line => !DRAFT_STOP_FIELDS.test(line))
  const at = lines.findIndex(line => !TITLE_OR_BLANK.test(line))
  lines.splice(at === -1 ? lines.length : at, 0, heading, ...generated)
  return lines.join('\n')
}

export function ownerStatusRefusal(text: string): string | null {
  const statusLine = statusLineOf(text)
  if (statusLine === undefined || statusOf(statusLine) !== 'OWNER')
    return null
  const boundary = NAMED_BOUNDARY.exec(statusLine)?.[1]
  if (boundary !== undefined && (OWNER_BOUNDARIES as readonly string[]).includes(boundary))
    return null
  return `${PREFIX}STATUS: OWNER must end with \`— boundary: <name>\`, the name one of ${OWNER_BOUNDARIES.join(', ')}; review changes, red CI, a denied form with an allowed route and who: window cards are executor work`
}

export function ownerWhileWorkIsFreeRefusal(text: string, reading: StateReading): string | null {
  if (statusOf(statusLineOf(text) ?? '') !== 'OWNER' || reading.kind !== 'read' || reading.state.ready.length === 0)
    return null
  return `${PREFIX}STATUS: OWNER while the bus holds ${reading.state.ready.map(card => `#${card.card}`).join(', ')}, which can be taken without the owner; owner questions go into the day file and the next card is taken`
}

export function ownerUnderDecisionsShardRefusal(text: string, shard: WindowShard | null): string | null {
  const statusLine = statusLineOf(text) ?? ''
  if (shard === null || statusOf(statusLine) !== 'OWNER' || NAMED_BOUNDARY.exec(statusLine)?.[1] === VERSION_PR_RESERVATION)
    return null
  return `${PREFIX}STATUS: OWNER under the active ${shard.scope} shard ${shard.id} (by ${shard.by}, until ${shard.until}); the window decides the question under the shard, and only boundary: ${VERSION_PR_RESERVATION} stays the owner's`
}

export function readingRefusals(draft: string): string[] {
  return draft.split(/\r?\n/).flatMap((line) => {
    if (WHOLE_READING.test(line))
      return [`${PREFIX}"${line.trim().slice(0, 60)}": orders a whole reading; the day file and its archive are read by a named heading`]
    if (DAY_ARCHIVE_NAME.test(line) && !NAMED_HEADING.test(line))
      return [`${PREFIX}"${line.trim().slice(0, 60)}": names the day archive without a heading; write <archive> § <heading>`]
    return []
  })
}

export type DayPlan = { kind: 'none' } | { kind: 'refused', why: string } | { kind: 'move', file: string, kept: string, archive: string, archiveText: string, moved: number }

export function planDay(draft: string, handoff: string, deps: Pick<HandoffWriteDeps, 'exists' | 'read' | 'home'>): DayPlan {
  const file = dayFileNamedIn(draft, deps.home, path.dirname(handoff))
  if (file === null || !deps.exists(file))
    return { kind: 'none' }
  const session = fieldValue(draft, 'session') ?? ''
  const { kept, moved } = splitDay(deps.read(file), session)
  const bytes = dayBytes(kept)
  if (bytes > DAY_FILE_LIMIT)
    return { kind: 'refused', why: `${PREFIX}day file ${file}: ${bytes} bytes of open owner questions and session ${session} owner texts after the archive, over the limit of ${DAY_FILE_LIMIT}; a question for the owner` }
  if (moved === '')
    return { kind: 'none' }
  const archive = archiveOfDay(file)
  return { kind: 'move', file, kept, archive, archiveText: appended(deps.exists(archive) ? deps.read(archive) : '', moved), moved: dayBytes(moved) }
}

function parseArgs(args: string[]): { handoff: string, draft: string } | null {
  const [handoff, draft, ...rest] = args
  if (handoff === undefined || draft === undefined || handoff.startsWith('--') || draft.startsWith('--') || rest.length > 0)
    return null
  return { handoff, draft }
}

export function runHandoffWrite(args: string[], deps: HandoffWriteDeps): number {
  const parsed = parseArgs(args)
  if (parsed === null) {
    deps.err(`${PREFIX}${USAGE}`)
    return 2
  }
  const draft = path.resolve(deps.cwd, parsed.draft)
  if (!deps.exists(draft)) {
    deps.err(`${PREFIX}no draft at ${draft}`)
    return 1
  }
  const handoff = path.resolve(deps.handoffDir ?? deps.cwd, parsed.handoff)
  if (deps.sessionHandoff !== null && !deps.exists(handoff) && handoff !== path.resolve(deps.sessionHandoff)) {
    deps.err(`${PREFIX}${handoff} is not this session's handoff and does not exist: one handoff per session, update ${deps.sessionHandoff} in place`)
    return 1
  }
  const archiveDir = path.join(path.dirname(handoff), ARCHIVE_DIR)
  const previous = deps.exists(handoff) ? deps.read(handoff) : null
  const archived = previous === null ? null : path.join(archiveDir, nextArchive(deps.exists(archiveDir) ? deps.listDir(archiveDir) : []))
  const prev = archived === null ? NO_PREV : path.relative(path.dirname(handoff), archived)
  const reading = deps.state()
  const waits = ownerWaits(deps.read(draft), deps.prState)
  const drafted = waits.draft
  const now = deps.now()
  const exitReadings = deps.readings()
  const reason = deps.stopReason(statusOf(drafted), exitReadings)
  const heading = `## STOP — ${fieldValue(drafted, 'role') ?? ''}, ${now.toISOString().slice(0, 10)}, session ${fieldValue(drafted, 'session') ?? ''}, boundary: ${boundaryOf(drafted, reason)}`
  const generated = [...mergedLines(deps.merged(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)), stopReasonLine(reason, exitReadings)]
  const stopped = withStop(drafted, heading, generated)
  const text = withPrev(reading.kind === 'read' ? withState(stopped, stateLines(reading.state)) : stopped, prev)
  const ownerRefusal = ownerStatusRefusal(text)
  const freeWorkRefusal = ownerWhileWorkIsFreeRefusal(text, reading)
  const shardRefusal = ownerUnderDecisionsShardRefusal(text, deps.decisionsShard(now))
  const day = planDay(drafted, handoff, deps)
  const refusals = [
    ...draftGeneratedRefusals(drafted),
    ...readingRefusals(drafted),
    ...(day.kind === 'refused' ? [day.why] : []),
    ...waits.refusals,
    ...nextTaskFormRefusals(drafted),
    ...(reading.kind === 'read' ? draftStateRefusals(drafted) : []),
    ...handoffRefusals(text, {
      file: handoff,
      home: deps.home,
      exists: file => file === archived || deps.exists(file),
      parked: deps.parked(),
    }),
    ...(ownerRefusal === null ? [] : [ownerRefusal]),
    ...(freeWorkRefusal === null ? [] : [freeWorkRefusal]),
    ...(shardRefusal === null ? [] : [shardRefusal]),
  ]
  if (refusals.length > 0) {
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}${draft} refused: nothing archived, ${handoff} unchanged`)
    return 1
  }
  if (day.kind === 'move') {
    deps.write(day.archive, day.archiveText)
    deps.write(day.file, day.kept)
    deps.out(`${PREFIX}${day.file}: ${dayBytes(day.kept)} bytes, ${day.moved} bytes moved to ${day.archive}`)
  }
  if (archived !== null && previous !== null) {
    deps.makeDir(archiveDir)
    deps.writeNew(archived, previous)
  }
  const staged = `${handoff}.writing`
  deps.makeDir(path.dirname(handoff))
  deps.write(staged, text.endsWith('\n') ? text : `${text}\n`)
  deps.rename(staged, handoff)
  deps.out(`${PREFIX}${handoff}: ${handoffBytes(text)} bytes, ${PREV_LABEL}: ${prev}, ${stateSource(reading)}`)
  return 0
}

function errorLine(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]! : String(error)
}

function busParked(busPath: string): ParkedDepends {
  try {
    return busParkedDepends(busPath)
  }
  catch {
    return new Map()
  }
}

function busState(busPath: string): StateReading {
  if (!existsSync(busPath))
    return { kind: 'unread', why: `no bus at ${busPath}` }
  try {
    const db = openBus(busPath)
    try {
      return { kind: 'read', state: readBoard({ db, now: new Date(), watched: [], leaseOrders: {} }) }
    }
    finally {
      db.close()
    }
  }
  catch (error) {
    return { kind: 'unread', why: `bus state at ${busPath} unreadable (${errorLine(error)})` }
  }
}

export function busMerged(busPath: string, since: string): MergedReading {
  if (!existsSync(busPath))
    return { kind: 'unread', why: `no bus at ${busPath}` }
  try {
    const db = openBus(busPath)
    try {
      const cards = db.prepare('SELECT DISTINCT card_id FROM events WHERE type = ? AND ts >= ? AND card_id IS NOT NULL ORDER BY card_id').all(MERGE_DONE, since) as { card_id: number | string }[]
      return { kind: 'read', cards: cards.map(row => Number(row.card_id)), merges: windowOf(db, 'merge').run.length, updates: windowOf(db, 'update').run.length }
    }
    finally {
      db.close()
    }
  }
  catch (error) {
    return { kind: 'unread', why: `bus at ${busPath} unreadable (${errorLine(error)})` }
  }
}

function busDecisionsShard(busPath: string, now: Date): WindowShard | null {
  if (!existsSync(busPath))
    return null
  try {
    const db = openBus(busPath)
    try {
      return activeDecisionsShard(db, now)
    }
    finally {
      db.close()
    }
  }
  catch {
    return null
  }
}

function ghPrState(pr: number): PrState {
  const read = readGhJson<{ state?: string } | null>(execGh, ['pr', 'view', String(pr), '--json', 'state'])
  const state = read.kind === 'read' ? read.value?.state : undefined
  return state === 'OPEN' || state === 'MERGED' || state === 'CLOSED' ? state : 'unread'
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runHandoffWrite(process.argv.slice(2), {
    cwd: process.cwd(),
    handoffDir: handoffDirOf(process.env, os.homedir(), process.cwd()),
    sessionHandoff: sessionHandoffOf(process.env, os.homedir()),
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    listDir: readdirSync,
    makeDir: dir => mkdirSync(dir, { recursive: true }),
    write: (file, text) => writeFileSync(file, text),
    writeNew: (file, text) => writeFileSync(file, text, { flag: 'wx' }),
    rename: renameSync,
    parked: () => busParked(defaultBusPath()),
    state: () => busState(defaultBusPath()),
    merged: since => busMerged(defaultBusPath(), since),
    prState: ghPrState,
    decisionsShard: now => busDecisionsShard(defaultBusPath(), now),
    readings: () => realExitReadings(process.env, os.homedir(), projectRoot(process.env), defaultBusPath()),
    stopReason: stopReasonOf,
    now: () => new Date(),
    home: os.homedir(),
    out: line => console.log(line),
    err: line => console.error(line),
  })
}

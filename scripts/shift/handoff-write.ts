import type { Board } from '../bus/board.js'
import type { ParkedDepends } from '../ghosts/handoff-check.js'
import type { ParkingReads } from './parking.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { parkingLanes, readBoard } from '../bus/board.js'
import { defaultBusPath, openBus } from '../bus/db.js'
import { defaultParking, handoffBytes, handoffRefusals, IN_FLIGHT_LABEL, NO_PREV, parkedDepends, PREV_LABEL, STATE_LABELS } from '../ghosts/handoff-check.js'
import { CARD_VARIABLE } from '../ghosts/session.js'
import { MIKO_HANDOFF_NAME } from '../miko/loop.js'
import { HANDOFF_VARIABLE, statusOf } from './relaunch.js'

export const PREFIX = '[handoff:write] '
export const USAGE = 'usage: pnpm handoff:write <handoff.md> <draft.md> [--parking <dir>]'
export const ARCHIVE_DIR = 'archive'
export const OWNER_BOUNDARIES = ['version-pr', 'owner-merged-kind', 'missing-right', 'owner-question'] as const

const ARCHIVED = /^(\d{4,})\.md$/
const STOP_HEADING = /^#{1,6} +STOP\b/
const PREV_LINE = new RegExp(`^\\s*(?:[-*+]\\s+)?${PREV_LABEL}:`, 'i')
const NAMED_BOUNDARY = /\s—\s*boundary:\s*(\S+)\s*$/
const STATE_LINE = new RegExp(`^\\s*(?:[-*+]\\s+)?(?:${STATE_LABELS.join('|')}):`, 'i')
const ANY_LABEL_LINE = /^\s*(?:[-*+]\s+)?[a-z][\w -]{0,30}:/i
const HEADING_LINE = /^#{1,6} /
const NOTHING = 'none'

export type HandoffState = Pick<Board, 'ready' | 'blocked' | 'lanes' | 'execution'>

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
  parked: (parking: string) => ParkedDepends
  state: () => HandoffState | null
  home: string
  out: (line: string) => void
  err: (line: string) => void
}

function setOrNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value
}

export function sessionHandoffOf(env: NodeJS.ProcessEnv, home: string): string | null {
  if (setOrNull(env[CARD_VARIABLE]) !== null)
    return null
  return setOrNull(env[HANDOFF_VARIABLE]) ?? path.join(setOrNull(env[HANDOFF_DIR_VARIABLE]) ?? path.join(home, '.construct', 'handoff'), MIKO_HANDOFF_NAME)
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
  return [
    `current card: ${joinedOrNothing(current, '; ')}`,
    `queue: ${joinedOrNothing(state.ready.map(card => `#${card.card}`), ' → ')}`,
    ...(state.execution.length === 0 ? [`${IN_FLIGHT_LABEL}: ${NOTHING}`] : [`${IN_FLIGHT_LABEL}:`, ...state.execution.map(inFlightEntry)]),
    `owner waits: ${joinedOrNothing(state.blocked.map(card => `#${card.card} ${card.reason}`), '; ')}`,
  ]
}

export function withState(draft: string, generated: readonly string[]): string {
  let dropping = false
  const lines = draft.split(/\r?\n/).filter((line) => {
    if (STATE_LINE.test(line)) {
      dropping = true
      return false
    }
    if (dropping && line.trim() !== '' && !HEADING_LINE.test(line) && !ANY_LABEL_LINE.test(line))
      return false
    if (line.trim() !== '')
      dropping = false
    return true
  })
  const stop = lines.findIndex(line => STOP_HEADING.test(line))
  lines.splice(stop + 1, 0, ...generated)
  return lines.join('\n')
}

export function ownerStatusRefusal(text: string): string | null {
  const statusLine = text.split(/\r?\n/).filter(line => statusOf(line) !== null).at(-1)
  if (statusLine === undefined || statusOf(statusLine) !== 'OWNER')
    return null
  const boundary = NAMED_BOUNDARY.exec(statusLine)?.[1]
  if (boundary !== undefined && (OWNER_BOUNDARIES as readonly string[]).includes(boundary))
    return null
  return `${PREFIX}STATUS: OWNER must end with \`— boundary: <name>\`, the name one of ${OWNER_BOUNDARIES.join(', ')}; review changes, red CI, a denied form with an allowed route and who: window cards are executor work`
}

function parseArgs(args: string[]): { handoff: string, draft: string, parking: string | null } | null {
  const [handoff, draft, ...rest] = args
  if (handoff === undefined || draft === undefined || handoff.startsWith('--') || draft.startsWith('--'))
    return null
  if (rest.length === 0)
    return { handoff, draft, parking: null }
  return rest.length === 2 && rest[0] === '--parking' ? { handoff, draft, parking: rest[1]! } : null
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
  const state = deps.state()
  const drafted = deps.read(draft)
  const text = withPrev(state === null ? drafted : withState(drafted, stateLines(state)), prev)
  const ownerRefusal = ownerStatusRefusal(text)
  const refusals = [
    ...handoffRefusals(text, {
      file: handoff,
      home: deps.home,
      exists: file => file === archived || deps.exists(file),
      parked: deps.parked(parsed.parking ?? defaultParking(deps.home)),
    }),
    ...(ownerRefusal === null ? [] : [ownerRefusal]),
  ]
  if (refusals.length > 0) {
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}${draft} refused: nothing archived, ${handoff} unchanged`)
    return 1
  }
  if (archived !== null && previous !== null) {
    deps.makeDir(archiveDir)
    deps.writeNew(archived, previous)
  }
  const staged = `${handoff}.writing`
  deps.write(staged, text.endsWith('\n') ? text : `${text}\n`)
  deps.rename(staged, handoff)
  const source = state === null ? `no bus state read, ${STATE_LABELS.join(', ')} as the draft wrote them` : `${STATE_LABELS.join(', ')} from the bus state`
  deps.out(`${PREFIX}${handoff}: ${handoffBytes(text)} bytes, ${PREV_LABEL}: ${prev}, ${source}`)
  return 0
}

function busState(home: string, handoffDir: string): HandoffState | null {
  const busPath = defaultBusPath()
  if (!existsSync(busPath))
    return null
  const db = openBus(busPath)
  try {
    const reads: ParkingReads = {
      cwd: process.cwd(),
      handoffDir,
      listDir: dir => readdirSync(dir),
      read: file => readFileSync(file, 'utf8'),
      exists: existsSync,
      git: (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }),
    }
    return readBoard({ db, now: new Date(), watched: [], parking: parkingLanes(reads, defaultParking(home)), leaseOrders: {} })
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runHandoffWrite(process.argv.slice(2), {
    cwd: process.cwd(),
    handoffDir: setOrNull(process.env[HANDOFF_DIR_VARIABLE]) ?? undefined,
    sessionHandoff: sessionHandoffOf(process.env, os.homedir()),
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    listDir: readdirSync,
    makeDir: dir => mkdirSync(dir, { recursive: true }),
    write: (file, text) => writeFileSync(file, text),
    writeNew: (file, text) => writeFileSync(file, text, { flag: 'wx' }),
    rename: renameSync,
    parked: parkedDepends,
    state: () => busState(os.homedir(), setOrNull(process.env[HANDOFF_DIR_VARIABLE]) ?? path.join(os.homedir(), '.construct', 'handoff')),
    home: os.homedir(),
    out: line => console.log(line),
    err: line => console.error(line),
  })
}

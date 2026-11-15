import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { WINDOW_HEARTBEAT } from '../../scripts/core/events.js'
import { withReadOnlyBus } from './cost/bus.js'
import { claudeProjectsDir, projectKey } from './cost/claude-code.js'

export const WINDOW_SILENT_MS = 20 * 60_000

export type FactoryState = 'live' | 'offline'

export interface FactoryLiveness {
  state: FactoryState
  lastBeat: string | null
}

const EVENTS_TABLE = `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'`
const NEWEST_WINDOW_BEAT = `SELECT max(ts) AS ts FROM events WHERE type = '${WINDOW_HEARTBEAT}' AND legacy = 0`

function newestWindowBeat(busFile: string): string | null {
  if (!existsSync(busFile))
    return null
  return withReadOnlyBus(busFile, (db) => {
    if (db.prepare(EVENTS_TABLE).get() === undefined)
      return null
    return (db.prepare(NEWEST_WINDOW_BEAT).get() as { ts: string | null }).ts
  })
}

export function factoryLiveness(busFile: string, nowMs: number): FactoryLiveness {
  const lastBeat = newestWindowBeat(busFile)
  const fresh = lastBeat !== null && nowMs - Date.parse(lastBeat) <= WINDOW_SILENT_MS
  return { state: fresh ? 'live' : 'offline', lastBeat }
}

export const LONG_GAP_MS = 5 * 60_000
export const SHOWN_ACTIONS = 8
const TRANSCRIPT_SUFFIX = '.jsonl'
const MINUTE_MS = 60_000
const DETAIL_CHARS = 80
const TIME_OF_DAY = { from: 11, to: 19 } as const
const DETAIL_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'description'] as const

export type TranscriptReader = (worktree: string, session: string) => string | null

export function transcriptReaderIn(projectsDir: string): TranscriptReader {
  return (worktree, session) => {
    const file = path.join(projectsDir, projectKey(worktree), `${session}${TRANSCRIPT_SUFFIX}`)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }
}

export const clientTranscriptReader: TranscriptReader = (worktree, session) => transcriptReaderIn(claudeProjectsDir())(worktree, session)

export interface TimedAction {
  id: string | null
  name: string
  detail: string | null
  at: string
  endedAt: string | null
}

export interface TranscriptGap {
  from: string
  to: string
  minutes: number
  after: string | null
}

export interface TranscriptReading {
  actions: TimedAction[]
  stamps: string[]
}

export interface WaitSource {
  source: 'scheduler' | 'lease' | 'node queue'
  reason: string
  since: string
}

export interface SessionTime {
  startedAt: string
  transcript: TranscriptReading | null
  wait: WaitSource | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stampOf(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null
}

function lineOf(text: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(text))
  }
  catch {
    return null
  }
}

function detailOf(input: unknown): string | null {
  const fields = record(input)
  const found = fields === null ? undefined : DETAIL_FIELDS.map(field => fields[field]).find(value => typeof value === 'string' && value.trim() !== '')
  if (typeof found !== 'string')
    return null
  const flat = found.replace(/\s+/g, ' ').trim()
  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 1)}…` : flat
}

function contentOf(line: Record<string, unknown>): Record<string, unknown>[] {
  const content = record(line.message)?.content
  return Array.isArray(content)
    ? (content as unknown[]).flatMap((item) => {
        const fields = record(item)
        return fields === null ? [] : [fields]
      })
    : []
}

export function readTranscript(text: string): TranscriptReading {
  const actions: TimedAction[] = []
  const stamps: string[] = []
  const open = new Map<string, TimedAction>()
  for (const raw of text.split('\n')) {
    const line = lineOf(raw)
    const at = line === null ? null : stampOf(line.timestamp)
    if (line === null || at === null)
      continue
    stamps.push(at)
    for (const item of contentOf(line)) {
      if (item.type === 'tool_use' && typeof item.name === 'string') {
        const action: TimedAction = { id: typeof item.id === 'string' ? item.id : null, name: item.name, detail: detailOf(item.input), at, endedAt: null }
        actions.push(action)
        if (action.id !== null)
          open.set(action.id, action)
      }
      if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
        const ended = open.get(item.tool_use_id)
        if (ended !== undefined) {
          ended.endedAt = at
          open.delete(item.tool_use_id)
        }
      }
    }
  }
  return { actions, stamps: stamps.sort() }
}

export function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / MINUTE_MS))
}

export function clockOf(stamp: string): string {
  return stamp.slice(TIME_OF_DAY.from, TIME_OF_DAY.to)
}

export function actionName(action: TimedAction): string {
  return action.detail === null ? action.name : `${action.name} ${action.detail}`
}

function lastActionBefore(actions: readonly TimedAction[], stamp: string): TimedAction | null {
  return actions.filter(action => action.at <= stamp).at(-1) ?? null
}

export function longGaps(reading: TranscriptReading, now: Date, live: boolean, gapMs = LONG_GAP_MS): TranscriptGap[] {
  const marks = live ? [...reading.stamps, now.toISOString()] : reading.stamps
  return marks.slice(1).flatMap((to, index) => {
    const from = marks[index]!
    if (Date.parse(to) - Date.parse(from) < gapMs)
      return []
    const before = lastActionBefore(reading.actions, from)
    return [{ from, to, minutes: minutesBetween(from, to), after: before === null ? null : actionName(before) }]
  })
}

export function runningAction(reading: TranscriptReading): TimedAction | null {
  return reading.actions.filter(action => action.endedAt === null).at(-1) ?? null
}

function waitPart(session: SessionTime, now: Date, gapMs: number): string {
  const { transcript, wait } = session
  if (transcript === null)
    return 'current action not read: no transcript of this session was found'
  const running = runningAction(transcript)
  if (running !== null)
    return `now ${actionName(running)} for ${minutesBetween(running.at, now.toISOString())} min`
  const last = transcript.stamps.at(-1) ?? session.startedAt
  const idle = minutesBetween(last, now.toISOString())
  const lastAction = transcript.actions.at(-1)
  const after = lastAction === undefined ? 'no tool run yet' : `last ${actionName(lastAction)} ended at ${clockOf(lastAction.endedAt ?? lastAction.at)}`
  if (wait !== null)
    return `waits on the ${wait.source}: ${wait.reason} for ${minutesBetween(wait.since, now.toISOString())} min · ${after}`
  if (now.getTime() - Date.parse(last) >= gapMs)
    return `waits for an unknown reason for ${idle} min, no line in the transcript since ${clockOf(last)} · ${after}`
  return `between actions for ${idle} min · ${after}`
}

export function sessionTimeLine(session: SessionTime, now: Date, gapMs = LONG_GAP_MS): string {
  return `started ${minutesBetween(session.startedAt, now.toISOString())} min ago · ${waitPart(session, now, gapMs)}`
}

export function sessionTimeIn(transcripts: TranscriptReader, session: string, startedAt: string, tree: string | null): SessionTime {
  const written = tree === null ? null : transcripts(tree, session)
  return { startedAt, transcript: written === null ? null : readTranscript(written), wait: null }
}

export function nowLine(reading: TranscriptReading, now: Date): string {
  const running = runningAction(reading)
  if (running !== null)
    return `now: ${actionName(running)}, running for ${minutesBetween(running.at, now.toISOString())} min`
  const last = reading.stamps.at(-1)
  return last === undefined ? 'now: the transcript holds no line yet' : `now: no tool running; the last transcript line is from ${clockOf(last)}, ${minutesBetween(last, now.toISOString())} min ago, and nothing says why it waits`
}

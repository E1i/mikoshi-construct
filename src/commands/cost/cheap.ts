import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { projectKey, readAgentRecord } from './claude-code.js'
import { median, MINIMUM_SAMPLE } from './sample.js'
import { tokensWithoutCacheReads } from './usage.js'

export const SHIFT_JOURNAL_FILE = 'shift.jsonl'
export const WINDOW_JOURNAL_FILE = 'ghosts.jsonl'

const CHEAP_CONTOUR = 'cheap'
const SUBAGENTS_DIR = 'subagents'
const SESSION_FILE_SUFFIX = '.jsonl'
const MS_PER_MINUTE = 60_000

export interface CheapSession {
  id: string
  project: string
}

export interface CheapTask {
  task: string
  taskClass: string
  sessions: CheapSession[]
  minutes: number
}

export interface CheapNote {
  taskClass: string
  text: string
}

export interface CheapSample {
  tasks: CheapTask[]
  notes: CheapNote[]
}

export interface CheapRow {
  task: string
  tokens: number
  minutes: number
}

export type CheapForecast
  = | { kind: 'forecast', taskClass: string, n: number, tokens: number, minutes: number }
    | { kind: 'none', taskClass: string, n: number }

export interface CheapClassReading {
  forecast: CheapForecast
  tasks: number
  notes: string[]
}

export interface CheapReading {
  shiftRoot: string
  windowJournal: string
  projectsDir: string
  classes: CheapClassReading[]
}

interface ShiftTaskLine {
  event?: unknown
  task?: unknown
  card?: { kind?: unknown, size?: unknown, contour?: unknown } | null
  worktree?: unknown
  session?: unknown
  continuations?: unknown
  started?: unknown
  ended?: unknown
  exit?: unknown
  report?: unknown
}

interface WindowLine {
  event?: unknown
  task?: unknown
  card?: { kind?: unknown, size?: unknown, contour?: unknown } | null
  started?: unknown
  pr?: unknown
  report?: unknown
  verification?: unknown
  ended?: unknown
  sessions?: unknown
}

export function defaultShiftRoot(): string {
  return path.join(homedir(), '.construct', 'shift')
}

export function defaultWindowJournal(): string {
  return path.join(homedir(), '.construct', 'handoff', WINDOW_JOURNAL_FILE)
}

export function cheapClass(card: { kind: string, size: string }): string {
  return `${card.kind}/${card.size}`
}

function parsed<Line>(text: string): Line | null {
  try {
    const value = JSON.parse(text) as unknown
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Line : null
  }
  catch {
    return null
  }
}

function finishedCheapTask(line: ShiftTaskLine | null): CheapTask | null {
  if (line?.event !== 'task' || line.exit !== 0 || line.report === false)
    return null
  const { card, task, worktree, session, started, ended } = line
  if (card == null || card.contour !== CHEAP_CONTOUR || typeof card.kind !== 'string' || typeof card.size !== 'string')
    return null
  if (typeof task !== 'string' || typeof worktree !== 'string' || typeof session !== 'string' || typeof started !== 'string' || typeof ended !== 'string')
    return null
  const minutes = (Date.parse(ended) - Date.parse(started)) / MS_PER_MINUTE
  if (!Number.isFinite(minutes) || minutes < 0)
    return null
  const continuations = Array.isArray(line.continuations) ? line.continuations.filter((entry): entry is string => typeof entry === 'string') : []
  const project = projectKey(worktree)
  return { task, taskClass: cheapClass({ kind: card.kind, size: card.size }), sessions: [session, ...continuations].map(id => ({ id, project })), minutes }
}

function journalLines<Line>(file: string): Line[] {
  if (!existsSync(file))
    return []
  return readFileSync(file, 'utf8').split('\n').filter(text => text.trim() !== '').flatMap((text) => {
    const line = parsed<Line>(text)
    return line === null ? [] : [line]
  })
}

function readShiftTasks(shiftRoot: string): CheapTask[] {
  if (!existsSync(shiftRoot))
    return []
  return readdirSync(shiftRoot)
    .sort()
    .map(name => path.join(shiftRoot, name, SHIFT_JOURNAL_FILE))
    .flatMap(file => journalLines<ShiftTaskLine>(file))
    .flatMap((line) => {
      const task = finishedCheapTask(line)
      return task === null ? [] : [task]
    })
}

function isPathLine(line: WindowLine): line is WindowLine & { task: string } {
  return line.event === 'path' && typeof line.task === 'string'
}

function recordedSessions(value: unknown): { id: string, project?: string }[] | null {
  if (!Array.isArray(value))
    return null
  return value.flatMap((entry: { id?: unknown, project?: unknown } | null) => {
    if (typeof entry?.id !== 'string')
      return []
    return [typeof entry.project === 'string' ? { id: entry.id, project: entry.project } : { id: entry.id }]
  })
}

function readWindowTasks(windowJournal: string, notes: CheapNote[]): CheapTask[] {
  const lines = journalLines<WindowLine>(windowJournal).filter(isPathLine)
  const starts = new Map(lines.filter(line => line.card != null).map(line => [line.task, line]))
  const closes = new Map(lines.filter(line => line.card == null && (line.pr != null || line.report != null)).map(line => [line.task, line]))
  const unrecorded = new Map<string, number>()
  const tasks = [...closes.values()].flatMap((close): CheapTask[] => {
    const start = starts.get(close.task)
    const card = start?.card
    if (card == null || card.contour !== CHEAP_CONTOUR || typeof card.kind !== 'string' || typeof card.size !== 'string' || typeof start?.started !== 'string')
      return []
    const taskClass = cheapClass({ kind: card.kind, size: card.size })
    if (typeof close.verification !== 'string') {
      notes.push({ taskClass, text: `#${close.task} close without verification not counted` })
      return []
    }
    const sessions = recordedSessions(close.sessions)
    if (sessions === null || typeof close.ended !== 'string') {
      unrecorded.set(taskClass, (unrecorded.get(taskClass) ?? 0) + 1)
      return []
    }
    const placed = sessions.flatMap(({ id, project }) => project === undefined ? [] : [{ id, project }])
    const unplaced = sessions.filter(session => session.project === undefined).map(session => session.id)
    if (unplaced.length > 0) {
      notes.push({ taskClass, text: `#${close.task} session ${unplaced.join(', ')} project not recorded in ${windowJournal}` })
      return []
    }
    if (sessions.length === 0) {
      notes.push({ taskClass, text: `#${close.task} sessions not recorded in ${windowJournal}` })
      return []
    }
    const minutes = (Date.parse(close.ended) - Date.parse(start.started)) / MS_PER_MINUTE
    if (!Number.isFinite(minutes) || minutes < 0)
      return []
    return [{ task: close.task, taskClass, sessions: placed, minutes }]
  })
  for (const [taskClass, count] of unrecorded)
    notes.push({ taskClass, text: `sessions not recorded on ${count} closing line${count === 1 ? '' : 's'} in ${windowJournal}` })
  return tasks
}

function withoutSharedSessions(tasks: CheapTask[], notes: CheapNote[]): CheapTask[] {
  const owners = new Map<string, Set<string>>()
  for (const task of tasks) {
    for (const session of task.sessions)
      owners.set(session.id, (owners.get(session.id) ?? new Set()).add(task.task))
  }
  return tasks.filter((task) => {
    const shared = task.sessions.filter(session => owners.get(session.id)!.size > 1)
    for (const session of shared) {
      const others = [...owners.get(session.id)!].filter(owner => owner !== task.task).map(owner => `#${owner}`)
      notes.push({ taskClass: task.taskClass, text: `#${task.task} session shared not recorded: ${session.id} is also recorded under ${others.join(', ')}` })
    }
    return shared.length === 0
  })
}

export function readCheapTasks(shiftRoot: string, windowJournal: string): CheapSample {
  const notes: CheapNote[] = []
  const shift = readShiftTasks(shiftRoot)
  const shiftIds = new Set(shift.map(task => task.task))
  const window = readWindowTasks(windowJournal, notes).filter(task => !shiftIds.has(task.task))
  return { tasks: withoutSharedSessions([...shift, ...window], notes), notes }
}

function subagentFiles(sessionDir: string): string[] {
  const dir = path.join(sessionDir, SUBAGENTS_DIR)
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith(SESSION_FILE_SUFFIX))
    .map(name => path.join(dir, name))
}

export function sessionTokens(projectsDir: string, session: CheapSession): number | null {
  const sessionDir = path.join(projectsDir, session.project, session.id)
  const main = `${sessionDir}${SESSION_FILE_SUFFIX}`
  if (!existsSync(main))
    return null
  return [main, ...subagentFiles(sessionDir)].reduce((sum, file) => sum + tokensWithoutCacheReads(readAgentRecord(file).usage), 0)
}

export function cheapRows(tasks: CheapTask[], taskClass: string, projectsDir: string): CheapRow[] {
  return tasks.filter(task => task.taskClass === taskClass).flatMap((task) => {
    const counts = task.sessions.map(session => sessionTokens(projectsDir, session))
    if (counts.includes(null))
      return []
    return [{ task: task.task, tokens: counts.reduce<number>((sum, count) => sum + (count ?? 0), 0), minutes: task.minutes }]
  })
}

export function cheapForecast(rows: CheapRow[], taskClass: string): CheapForecast {
  if (rows.length < MINIMUM_SAMPLE)
    return { kind: 'none', taskClass, n: rows.length }
  return { kind: 'forecast', taskClass, n: rows.length, tokens: median(rows.map(row => row.tokens)), minutes: median(rows.map(row => row.minutes)) }
}

export function cheapForecastOf(shiftRoot: string, windowJournal: string, taskClass: string, projectsDir: string): CheapForecast {
  return cheapForecast(cheapRows(readCheapTasks(shiftRoot, windowJournal).tasks, taskClass, projectsDir), taskClass)
}

export function readCheapClasses(shiftRoot: string, windowJournal: string, projectsDir: string): CheapReading {
  const { tasks, notes } = readCheapTasks(shiftRoot, windowJournal)
  const classes = [...new Set([...tasks, ...notes].map(entry => entry.taskClass))].sort().map(taskClass => ({
    forecast: cheapForecast(cheapRows(tasks, taskClass, projectsDir), taskClass),
    tasks: tasks.filter(task => task.taskClass === taskClass).length,
    notes: notes.filter(note => note.taskClass === taskClass).map(note => note.text),
  }))
  return { shiftRoot, windowJournal, projectsDir, classes }
}

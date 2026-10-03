import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { projectKey } from './claude-code.js'

export const SHIFT_JOURNAL_FILE = 'shift.jsonl'
export const MINIMUM_CHEAP_SAMPLE = 5

const CHEAP_CONTOUR = 'cheap'
const SUBAGENTS_DIR = 'subagents'
const SESSION_FILE_SUFFIX = '.jsonl'
const MS_PER_MINUTE = 60_000

export interface CheapTask {
  task: string
  taskClass: string
  worktree: string
  sessions: string[]
  minutes: number
}

export interface CheapRow {
  task: string
  tokens: number
  minutes: number
}

export type CheapForecast
  = | { kind: 'forecast', taskClass: string, n: number, tokens: number, minutes: number }
    | { kind: 'none', taskClass: string, n: number }

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

interface UsageLine {
  requestId?: string
  message?: {
    role?: string
    usage?: {
      input_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      output_tokens?: number
    }
  }
}

export function defaultShiftRoot(): string {
  return path.join(homedir(), '.construct', 'shift')
}

export function cheapClass(card: { kind: string, size: string }): string {
  return `${card.kind}/${card.size}`
}

function parsed(text: string): ShiftTaskLine | null {
  try {
    const value = JSON.parse(text) as unknown
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value as ShiftTaskLine : null
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
  return { task, taskClass: cheapClass({ kind: card.kind, size: card.size }), worktree, sessions: [session, ...continuations], minutes }
}

export function readCheapTasks(shiftRoot: string): CheapTask[] {
  if (!existsSync(shiftRoot))
    return []
  return readdirSync(shiftRoot)
    .sort()
    .map(name => path.join(shiftRoot, name, SHIFT_JOURNAL_FILE))
    .filter(existsSync)
    .flatMap(file => readFileSync(file, 'utf8').split('\n'))
    .filter(text => text.trim() !== '')
    .flatMap((text) => {
      const task = finishedCheapTask(parsed(text))
      return task === null ? [] : [task]
    })
}

function fileTokens(file: string): number {
  const counted = new Set<string>()
  let tokens = 0
  for (const text of readFileSync(file, 'utf8').split('\n')) {
    if (!text.startsWith('{'))
      continue
    let entry: UsageLine
    try {
      entry = JSON.parse(text) as UsageLine
    }
    catch {
      continue
    }
    const usage = entry.message?.role === 'assistant' ? entry.message.usage : undefined
    if (usage == null)
      continue
    if (entry.requestId != null) {
      if (counted.has(entry.requestId))
        continue
      counted.add(entry.requestId)
    }
    tokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0)
  }
  return tokens
}

function subagentFiles(sessionDir: string): string[] {
  const dir = path.join(sessionDir, SUBAGENTS_DIR)
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith(SESSION_FILE_SUFFIX))
    .map(name => path.join(dir, name))
}

export function sessionTokens(projectsDir: string, worktree: string, session: string): number | null {
  const sessionDir = path.join(projectsDir, projectKey(worktree), session)
  const main = `${sessionDir}${SESSION_FILE_SUFFIX}`
  if (!existsSync(main))
    return null
  return [main, ...subagentFiles(sessionDir)].reduce((sum, file) => sum + fileTokens(file), 0)
}

export function cheapRows(tasks: CheapTask[], taskClass: string, projectsDir: string): CheapRow[] {
  return tasks.filter(task => task.taskClass === taskClass).flatMap((task) => {
    const counts = task.sessions.map(session => sessionTokens(projectsDir, task.worktree, session))
    if (counts.includes(null))
      return []
    return [{ task: task.task, tokens: counts.reduce<number>((sum, count) => sum + (count ?? 0), 0), minutes: task.minutes }]
  })
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function cheapForecast(rows: CheapRow[], taskClass: string): CheapForecast {
  if (rows.length < MINIMUM_CHEAP_SAMPLE)
    return { kind: 'none', taskClass, n: rows.length }
  return { kind: 'forecast', taskClass, n: rows.length, tokens: median(rows.map(row => row.tokens)), minutes: median(rows.map(row => row.minutes)) }
}

export function cheapForecastOf(shiftRoot: string, taskClass: string, projectsDir: string): CheapForecast {
  return cheapForecast(cheapRows(readCheapTasks(shiftRoot), taskClass, projectsDir), taskClass)
}

import type { Usage } from './usage.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { add, emptyUsage } from './usage.js'

export const TURN_JOURNAL_FILE = '.construct/turns.jsonl'

const JOURNAL_VERSION = 1
const KINDS = ['turn', 'late', 'subagent', 'session-end']
const MEASURED_KINDS = ['turn', 'late']

export interface MalformedTurnLine {
  line: number
  reason: string
}

export type TurnSummary
  = | { status: 'not recorded' }
    | {
      status: 'recorded'
      turns: number
      sessions: number
      main: Usage
      subagents: Usage
      unmeasured: number
      gaps: number
      malformed: MalformedTurnLine[]
    }

interface JournalLine {
  v?: unknown
  kind?: unknown
  session?: unknown
  usage?: unknown
  from?: unknown
  to?: unknown
}

function isUsage(value: unknown): value is Usage {
  if (value == null || typeof value !== 'object')
    return false
  const usage = value as Record<string, unknown>
  return ['calls', 'input', 'cacheWrite', 'cacheRead', 'output'].every(field => typeof usage[field] === 'number' && Number.isFinite(usage[field]))
    && Array.isArray(usage.models)
}

function parsedLine(text: string): JournalLine | null {
  try {
    const value = JSON.parse(text) as unknown
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value as JournalLine : null
  }
  catch {
    return null
  }
}

function problemWith(line: JournalLine | null): string | null {
  if (line == null)
    return 'not JSON'
  if (line.v !== JOURNAL_VERSION)
    return `version ${String(line.v)} is not ${JOURNAL_VERSION}`
  if (typeof line.kind !== 'string' || !KINDS.includes(line.kind))
    return 'kind is not one of the four'
  if (typeof line.session !== 'string' || line.session === '')
    return 'no session'
  if (line.kind === 'session-end')
    return null
  if (line.kind === 'turn' && line.usage === 'unknown')
    return null
  return isUsage(line.usage) ? null : 'usage is neither a usage object nor unknown'
}

export function readTurnJournal(root: string): TurnSummary {
  const file = path.join(root, TURN_JOURNAL_FILE)
  if (!existsSync(file))
    return { status: 'not recorded' }
  const main = emptyUsage()
  const subagents = emptyUsage()
  const sessions = new Set<string>()
  const malformed: MalformedTurnLine[] = []
  const previousEnd = new Map<string, unknown>()
  let turns = 0
  let unmeasured = 0
  let gaps = 0
  readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
    if (text.trim() === '')
      return
    const line = parsedLine(text)
    const problem = problemWith(line)
    if (problem != null || line == null) {
      malformed.push({ line: index + 1, reason: problem ?? 'not JSON' })
      return
    }
    const session = line.session as string
    const kind = line.kind as string
    sessions.add(session)
    if (kind === 'subagent')
      add(subagents, line.usage as Usage)
    if (!MEASURED_KINDS.includes(kind))
      return
    if (kind === 'turn')
      turns += 1
    if (line.usage === 'unknown')
      unmeasured += 1
    else
      add(main, line.usage as Usage)
    if (line.from != null && previousEnd.has(session) && previousEnd.get(session) !== line.from)
      gaps += 1
    previousEnd.set(session, line.to)
  })
  return { status: 'recorded', turns, sessions: sessions.size, main, subagents, unmeasured, gaps, malformed }
}

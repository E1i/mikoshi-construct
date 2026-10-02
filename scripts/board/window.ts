import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const TURNS_JOURNAL = path.join('.construct', 'turns.jsonl')
const TURN_KINDS = ['turn', 'late', 'subagent']

export interface Window {
  session: string | undefined
  lastAt: Date | undefined
  ended: boolean
  context: number | undefined
}

interface TurnLine {
  kind?: unknown
  session?: unknown
  endedAt?: unknown
  at?: unknown
  context?: unknown
}

function parsed(line: string): TurnLine {
  try {
    return (JSON.parse(line) ?? {}) as TurnLine
  }
  catch {
    return {}
  }
}

function timeOf(entry: TurnLine): Date | undefined {
  const text = entry.endedAt ?? entry.at
  const time = typeof text === 'string' ? new Date(text) : undefined
  return time === undefined || Number.isNaN(time.getTime()) ? undefined : time
}

function readTurns(root: string): TurnLine[] {
  const file = path.join(root, TURNS_JOURNAL)
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').map(parsed) : []
  }
  catch {
    return []
  }
}

export function readWindow(roots: (string | undefined)[], session: string | undefined): Window {
  const window: Window = { session, lastAt: undefined, ended: false, context: undefined }
  if (session === undefined)
    return window
  const unique = [...new Set(roots.flatMap(root => root === undefined ? [] : [path.resolve(root)]))]
  for (const entry of unique.flatMap(readTurns).filter(candidate => candidate.session === session)) {
    if (entry.kind === 'session-end')
      window.ended = true
    const time = TURN_KINDS.includes(entry.kind as string) ? timeOf(entry) : undefined
    if (time !== undefined && (window.lastAt === undefined || time > window.lastAt))
      window.lastAt = time
    if (time !== undefined && typeof entry.context === 'number' && Number.isFinite(entry.context))
      window.context = entry.context
  }
  return window
}

export function isEnded(window: Window): boolean {
  return window.session !== undefined && window.ended
}

export function isLive(window: Window): boolean {
  return window.session !== undefined && !window.ended
}

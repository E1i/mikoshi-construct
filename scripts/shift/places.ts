import type { Card } from '../../src/card/grammar.js'
import type { ExitReason } from './continuation.js'
import path from 'node:path'

export const SHIFT_JOURNAL = 'shift.jsonl'
export const REPO = 'E1i/mikoshi-construct'
export const GHOST_JOURNAL = 'ghosts.jsonl'

export function reportPath(dir: string, number: string): string {
  return path.join(dir, `report-${number}.md`)
}

export function logPath(dir: string, number: string, restart = 0): string {
  return path.join(dir, restart === 0 ? `log-${number}.txt` : `log-${number}.${restart}.txt`)
}

export function eddiesJournalPath(worktree: string): string {
  return path.join(worktree, '.construct', 'eddies.jsonl')
}

export function exitedWithoutReport(line: TaskLine): boolean {
  return line.exit === 0 && line.report === false
}

export function succeeded(line: TaskLine): boolean {
  return line.exit === 0 && !exitedWithoutReport(line)
}

export interface TaskLine {
  event: 'task'
  file: string
  number: string
  task: string
  card?: Card
  branch: string
  session: string
  worktree: string | null
  started: string
  ended: string
  exit: number | null
  signal: string | null
  report?: boolean
  continuations?: string[]
  lastExit?: ExitReason
  refused?: string
  error?: string
}

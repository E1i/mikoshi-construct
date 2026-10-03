import type { Card } from '../ghosts/card.js'
import path from 'node:path'

export const SHIFT_JOURNAL = 'shift.jsonl'
export const REPO = 'E1i/mikoshi-construct'

export function reportPath(dir: string, number: string): string {
  return path.join(dir, `report-${number}.md`)
}

export function logPath(dir: string, number: string): string {
  return path.join(dir, `log-${number}.txt`)
}

export function exitedWithoutReport(line: TaskLine): boolean {
  return line.exit === 0 && line.report === false
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
  refused?: string
  error?: string
}

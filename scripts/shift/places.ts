import path from 'node:path'

export const SHIFT_JOURNAL = 'shift.jsonl'
export const REPO = 'E1i/mikoshi-construct'

export function reportPath(dir: string, number: string): string {
  return path.join(dir, `report-${number}.md`)
}

export function logPath(dir: string, number: string): string {
  return path.join(dir, `log-${number}.txt`)
}

export interface TaskLine {
  event: 'task'
  file: string
  number: string
  task: string
  branch: string
  session: string
  worktree: string | null
  started: string
  ended: string
  exit: number | null
  signal: string | null
  refused?: string
  error?: string
}

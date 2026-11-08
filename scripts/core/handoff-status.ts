import { existsSync, readFileSync } from 'node:fs'

export const HANDOFF_STATUSES = ['CONTINUE', 'OWNER', 'DONE', 'STOP'] as const

export type Status = typeof HANDOFF_STATUSES[number]

export interface StatusLine {
  status: Status
  line: string
  value: string
}

const STATUS_LINE = new RegExp(`^STATUS:\\s*((${HANDOFF_STATUSES.join('|')})\\b.*)$`)

function statusLineIn(line: string): StatusLine | null {
  const match = STATUS_LINE.exec(line)
  return match === null ? null : { status: match[2] as Status, line, value: match[1]!.trim() }
}

export function statusLineOf(text: string): StatusLine | null {
  return text.split(/\r?\n/).map(statusLineIn).filter(found => found !== null).at(-1) ?? null
}

export function statusOf(text: string): Status | null {
  return statusLineOf(text)?.status ?? null
}

export function statusOfFile(file: string): Status | null | undefined {
  return existsSync(file) ? statusOf(readFileSync(file, 'utf8')) : undefined
}

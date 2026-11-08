import type { BoardCheck } from '../ci/state.js'
import { readFileSync } from 'node:fs'
import { isTime, rollupFault, rollupFields } from '../ci/state.js'

export { PRS_COMMAND } from '../ci/state.js'

export const PRS_FROM_STDIN = '-'

const PULL_REQUEST_STATES = ['OPEN', 'MERGED', 'CLOSED']

export interface PullRequest {
  number: number
  title: string
  state: string
  createdAt: string
  closedAt: string | null
  mergedAt: string | null
  statusCheckRollup: BoardCheck[]
}

export type PrsReading
  = | { status: 'not read' }
    | { status: 'read', file: string, prs: PullRequest[] }
    | { status: 'unreadable', file: string, reason: string }

function isTimeOrNull(value: unknown): boolean {
  return value == null || isTime(value)
}

function faultOf(entry: unknown, index: number): string | undefined {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry))
    return `entry ${index + 1} is not an object`
  const pr = entry as Record<string, unknown>
  if (!Number.isInteger(pr.number))
    return `entry ${index + 1} has no pull request number`
  if (typeof pr.title !== 'string' || !PULL_REQUEST_STATES.includes(pr.state as string))
    return `entry ${index + 1} has no title or no state of OPEN, MERGED or CLOSED`
  if (!isTime(pr.createdAt) || !isTimeOrNull(pr.closedAt) || !isTimeOrNull(pr.mergedAt))
    return `entry ${index + 1} has a time that is not a date`
  return rollupFault(pr, index)
}

function parsePrs(text: string): PullRequest[] | string {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    return 'not JSON'
  }
  if (!Array.isArray(raw))
    return 'not a JSON array'
  const fault = raw.map(faultOf).find(found => found !== undefined)
  if (fault !== undefined)
    return fault
  return raw.map((entry: PullRequest) => ({ ...entry, closedAt: entry.closedAt ?? null, mergedAt: entry.mergedAt ?? null, ...rollupFields(entry) }))
}

export function readPrs(file: string | undefined, readStdin: () => string): PrsReading {
  if (file === undefined)
    return { status: 'not read' }
  let text: string
  try {
    text = file === PRS_FROM_STDIN ? readStdin() : readFileSync(file, 'utf8')
  }
  catch (error) {
    return { status: 'unreadable', file, reason: error instanceof Error ? error.message : String(error) }
  }
  const prs = parsePrs(text)
  return typeof prs === 'string' ? { status: 'unreadable', file, reason: prs } : { status: 'read', file, prs }
}

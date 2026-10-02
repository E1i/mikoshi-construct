import { readFileSync } from 'node:fs'

export const PRS_COMMAND = 'gh pr list --state all --limit 100 --json number,title,state,createdAt,closedAt,mergedAt,statusCheckRollup'
export const PRS_FROM_STDIN = '-'

const PULL_REQUEST_STATES = ['OPEN', 'MERGED', 'CLOSED']
const PASSING_CONCLUSIONS = ['SUCCESS', 'SKIPPED', 'NEUTRAL']
const FAILING_STATES = ['FAILURE', 'ERROR']
const UNFINISHED_STATES = ['PENDING', 'EXPECTED']

export interface Check {
  status?: string
  conclusion?: string
  context?: string
  state?: string
  completedAt?: string
}

export interface PullRequest {
  number: number
  title: string
  state: string
  createdAt: string
  closedAt: string | null
  mergedAt: string | null
  statusCheckRollup: Check[]
}

export type PrsReading
  = | { status: 'not read' }
    | { status: 'read', file: string, prs: PullRequest[] }
    | { status: 'unreadable', file: string, reason: string }

type CiState = 'none' | 'red' | 'green' | 'pending'

export interface Ci {
  state: CiState
  completedAt: string | undefined
}

function isTime(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isTimeOrNull(value: unknown): boolean {
  return value == null || isTime(value)
}

function isListOfObjects(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => item != null && typeof item === 'object' && !Array.isArray(item))
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
  if (pr.statusCheckRollup != null && !isListOfObjects(pr.statusCheckRollup))
    return `entry ${index + 1} has a statusCheckRollup that is not a list of checks`
  return undefined
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
  return raw.map((entry: PullRequest) => ({ ...entry, closedAt: entry.closedAt ?? null, mergedAt: entry.mergedAt ?? null, statusCheckRollup: entry.statusCheckRollup ?? [] }))
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

function isFailing(check: Check): boolean {
  if (check.context !== undefined)
    return FAILING_STATES.includes(check.state ?? '')
  return check.status === 'COMPLETED' && !PASSING_CONCLUSIONS.includes(check.conclusion ?? '')
}

function isFinished(check: Check): boolean {
  if (check.context !== undefined)
    return !UNFINISHED_STATES.includes(check.state ?? '')
  return check.status === 'COMPLETED'
}

function latestCompletion(checks: Check[]): string | undefined {
  const times = checks.map(check => check.completedAt).filter((time): time is string => isTime(time))
  return times.length === 0 ? undefined : times.reduce((latest, time) => Date.parse(time) > Date.parse(latest) ? time : latest)
}

export function ciOf(checks: Check[]): Ci {
  const completedAt = latestCompletion(checks)
  if (checks.length === 0)
    return { state: 'none', completedAt }
  if (checks.some(isFailing))
    return { state: 'red', completedAt }
  return { state: checks.every(isFinished) ? 'green' : 'pending', completedAt }
}

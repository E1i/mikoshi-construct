import type { WorkflowRun } from './usage.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const LEDGER_FILE = '.construct/runs.jsonl'

export type TokenCount = number | 'unknown'

export interface LedgerAttempt {
  rung: number
  effort: string
  outcome: string
  reason: string
}

export interface LedgerEntry {
  run: string | null
  at: string
  task: string
  effort: string
  status: string
  rung: string
  attempts: LedgerAttempt[]
  agents: number
  tokens: TokenCount
  toolUses: number
  seconds: number
  cause?: Cause | typeof CAUSE_NOT_RECORDED
  tokensSource?: TokenSource
}

export interface MalformedLedgerLine {
  line: number
  reason: string
}

export interface LedgerReading {
  entries: LedgerEntry[]
  malformed: MalformedLedgerLine[]
}

export interface LedgerSummary {
  runs: number
  agents: number
  failures: number
  tokens: TokenCount
  malformed: MalformedLedgerLine[]
}

export interface Reconciliation {
  entriesWithoutSession: string[]
  sessionsWithoutEntry: string[]
  unjoinable: number
}

export const CAUSES = {
  stopped: ['environment', 'human'],
  failed: ['environment', 'task'],
} as const
export type Cause = typeof CAUSES[keyof typeof CAUSES][number]
const CAUSE_NOT_RECORDED = 'not recorded'
const CAUSE_REQUIRED_SINCE_THE_STATUS_EXISTS = ['stopped']
export const TOKEN_SOURCES = ['runtime'] as const
export type TokenSource = typeof TOKEN_SOURCES[number]

const TEXT_FIELDS = ['at', 'task', 'effort', 'status', 'rung'] as const
const COUNT_FIELDS = ['agents', 'toolUses', 'seconds'] as const

function isText(value: unknown): boolean {
  return typeof value === 'string' && value !== ''
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

function isTokenCount(value: unknown): boolean {
  return value === 'unknown' || isCount(value)
}

function attemptFaults(value: unknown, index: number): string[] {
  if (value == null || typeof value !== 'object')
    return [`attempts[${index}] is not a record`]
  const attempt = value as Record<string, unknown>
  return [
    isCount(attempt.rung) ? null : `attempts[${index}].rung`,
    isText(attempt.effort) ? null : `attempts[${index}].effort`,
    isText(attempt.outcome) ? null : `attempts[${index}].outcome`,
    typeof attempt.reason === 'string' ? null : `attempts[${index}].reason`,
  ].filter(fault => fault != null)
}

function attemptListFaults(value: unknown): string[] {
  if (!Array.isArray(value))
    return ['attempts']
  return value.flatMap(attemptFaults)
}

function undeclaredFields(record: Record<string, unknown>): string[] {
  const missing: string[] = [
    ...TEXT_FIELDS.filter(field => !isText(record[field])),
    ...COUNT_FIELDS.filter(field => !isCount(record[field])),
  ]
  if (!isTokenCount(record.tokens))
    missing.push('tokens')
  missing.push(...attemptListFaults(record.attempts))
  if (causeFault(record))
    missing.push('cause')
  if ('tokensSource' in record && !(TOKEN_SOURCES as readonly unknown[]).includes(record.tokensSource))
    missing.push('tokensSource')
  return missing
}

function causesFor(status: unknown): readonly Cause[] | undefined {
  return Object.hasOwn(CAUSES, status as string) ? CAUSES[status as keyof typeof CAUSES] : undefined
}

function causeFault(record: Record<string, unknown>): boolean {
  const causes = causesFor(record.status)
  if (causes == null)
    return 'cause' in record
  if (!('cause' in record))
    return CAUSE_REQUIRED_SINCE_THE_STATUS_EXISTS.includes(record.status as string)
  return !(causes as readonly unknown[]).includes(record.cause)
}

function toAttempt(value: unknown): LedgerAttempt {
  const attempt = value as Record<string, unknown>
  return { rung: attempt.rung as number, effort: attempt.effort as string, outcome: attempt.outcome as string, reason: attempt.reason as string }
}

function toEntry(raw: unknown): LedgerEntry | string {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
    return 'not a run record'
  const record = raw as Record<string, unknown>
  const missing = undeclaredFields(record)
  if (missing.length > 0)
    return `missing or invalid: ${missing.join(', ')}`
  return {
    run: isText(record.run) ? record.run as string : null,
    at: record.at as string,
    task: record.task as string,
    effort: record.effort as string,
    status: record.status as string,
    rung: record.rung as string,
    attempts: (record.attempts as unknown[]).map(toAttempt),
    agents: record.agents as number,
    tokens: record.tokens as TokenCount,
    toolUses: record.toolUses as number,
    seconds: record.seconds as number,
    ...(causesFor(record.status) == null ? {} : { cause: 'cause' in record ? record.cause as Cause : CAUSE_NOT_RECORDED }),
    ...('tokensSource' in record ? { tokensSource: record.tokensSource as TokenSource } : {}),
  }
}

export function readLedger(root: string): LedgerReading {
  const file = path.join(root, LEDGER_FILE)
  const reading: LedgerReading = { entries: [], malformed: [] }
  if (!existsSync(file))
    return reading
  readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
    const line = index + 1
    if (text.trim() === '')
      return
    let raw: unknown
    try {
      raw = JSON.parse(text)
    }
    catch {
      reading.malformed.push({ line, reason: 'not JSON' })
      return
    }
    const entry = toEntry(raw)
    if (typeof entry === 'string')
      reading.malformed.push({ line, reason: entry })
    else
      reading.entries.push(entry)
  })
  return reading
}

export function summarizeLedger(reading: LedgerReading): LedgerSummary {
  const anyTokenUnknown = reading.entries.some(entry => entry.tokens === 'unknown')
  const counted = reading.entries.reduce((total, entry) => total + (entry.tokens === 'unknown' ? 0 : entry.tokens), 0)
  return {
    runs: reading.entries.length,
    agents: reading.entries.reduce((total, entry) => total + entry.agents, 0),
    failures: reading.entries.filter(entry => entry.status !== 'done').length,
    tokens: anyTokenUnknown ? 'unknown' : counted,
    malformed: reading.malformed,
  }
}

export function withoutTokenTotals(summary: LedgerSummary): LedgerSummary {
  return { ...summary, tokens: 'unknown' }
}

export function hasLedgerFindings(summary: LedgerSummary): boolean {
  return summary.runs > 0 || summary.malformed.length > 0
}

export function reconcile(entries: LedgerEntry[], runs: WorkflowRun[]): Reconciliation {
  const sessionRuns = new Set(runs.map(run => run.run))
  const ledgerRuns = entries.map(entry => entry.run).filter((run): run is string => run != null)
  const joinable = new Set(ledgerRuns)
  return {
    entriesWithoutSession: [...joinable].filter(run => !sessionRuns.has(run)),
    sessionsWithoutEntry: runs.map(run => run.run).filter(run => !joinable.has(run)),
    unjoinable: entries.length - ledgerRuns.length,
  }
}

import type { BusEvent } from '../../core/db.js'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { appendEvent, BUSY_TIMEOUT_MS, defaultBusPath } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { exitCodePath, treeReportPath } from '../../core/places.js'
import { openDatabase } from '../../core/sqlite.js'

export const REPORT_MISSING = 'report-missing'

export const TREE_GATE_RUN_SPOOL = path.join('.construct', 'gate-runs.jsonl')

export type GateRunDrain
  = | { kind: 'drained', count: number }
    | { kind: 'kept', reason: string }

export function drainTreeGateRuns(worktree: string, append: (event: BusEvent) => void): GateRunDrain {
  const spool = path.join(worktree, TREE_GATE_RUN_SPOOL)
  if (!existsSync(spool))
    return { kind: 'drained', count: 0 }
  try {
    const events = readFileSync(spool, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as BusEvent)
    events.forEach(append)
    rmSync(spool, { force: true })
    return { kind: 'drained', count: events.length }
  }
  catch (error) {
    return { kind: 'kept', reason: messageOf(error) }
  }
}

export function drainTreeGateRunsInto(worktree: string, busPath: string = defaultBusPath()): GateRunDrain {
  if (!existsSync(path.join(worktree, TREE_GATE_RUN_SPOOL)))
    return { kind: 'drained', count: 0 }
  if (!existsSync(busPath))
    return { kind: 'kept', reason: `no bus file at ${busPath}` }
  const db = openDatabase(busPath, { timeout: BUSY_TIMEOUT_MS })
  try {
    return drainTreeGateRuns(worktree, event => appendEvent(db, event))
  }
  finally {
    db.close()
  }
}

export type ReportCollection
  = | { kind: 'collected', tree: string, saved: string, gateRuns?: GateRunDrain }
    | { kind: 'absent', tree: string, gateRuns?: GateRunDrain }
    | { kind: 'unreadable', tree: string, reason: string, gateRuns?: GateRunDrain }

function removeFromTree(tree: string): void {
  rmSync(tree, { recursive: true, force: true })
}

function drainedOnCollection(worktree: string, busPath: string | undefined): GateRunDrain {
  try {
    return drainTreeGateRunsInto(worktree, busPath)
  }
  catch (error) {
    return { kind: 'kept', reason: messageOf(error) }
  }
}

export function collectReport(worktree: string, saved: string, busPath?: string): ReportCollection {
  const gateRuns = drainedOnCollection(worktree, busPath)
  const report = reportOf(worktree, saved)
  return gateRuns.kind === 'drained' && gateRuns.count === 0 ? report : { ...report, gateRuns }
}

function reportOf(worktree: string, saved: string): ReportCollection {
  const tree = treeReportPath(worktree)
  if (!existsSync(tree))
    return { kind: 'absent', tree }
  let text: string
  try {
    text = readFileSync(tree, 'utf8')
  }
  catch (error) {
    removeFromTree(tree)
    return { kind: 'unreadable', tree, reason: messageOf(error) }
  }
  if (text.trim() === '') {
    removeFromTree(tree)
    return { kind: 'unreadable', tree, reason: 'the file is empty' }
  }
  mkdirSync(path.dirname(saved), { recursive: true })
  writeFileSync(saved, text)
  removeFromTree(tree)
  return { kind: 'collected', tree, saved }
}

export function recordedExitCode(launchDir: string, cardId: number, sinceMs: number): string | null {
  const file = exitCodePath(launchDir, String(cardId))
  if (!existsSync(file) || statSync(file).mtimeMs < sinceMs)
    return null
  const code = readFileSync(file, 'utf8').trim()
  return code === '' ? null : code
}

export function missingReportDetail(cardId: number, collection: Exclude<ReportCollection, { kind: 'collected' }>, exitCode: string | null): string {
  const what = collection.kind === 'absent' ? 'no report was written there' : `the report cannot be read: ${collection.reason}`
  const exit = exitCode === null ? 'no exit code was recorded (the session was stopped or killed)' : `the session exited with code ${exitCode}`
  return `${REPORT_MISSING}: card #${cardId}: the shift report ${collection.tree}: ${what}; ${exit}`
}

export const USAGE_LIMIT = 'usage-limit'

const USAGE_LIMIT_REACHED = 'usage_limit_reached'
const CONVERSATION_RECORDS: readonly unknown[] = ['assistant', 'user']
const MS_PER_SECOND = 1000
const RESETS_AT = /\bresets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/

interface TranscriptRecord {
  type?: unknown
  apiError?: unknown
  quotaLimits?: { resetsAt?: unknown } | null
}

function recordOf(line: string): TranscriptRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed as TranscriptRecord : null
  }
  catch {
    return null
  }
}

export function usageLimitResetOf(transcript: string | null): string | null {
  if (transcript === null)
    return null
  const last = transcript.split('\n').map(recordOf).filter(record => record !== null && CONVERSATION_RECORDS.includes(record.type)).at(-1)
  const resetsAt = last?.quotaLimits?.resetsAt
  if (last?.apiError !== USAGE_LIMIT_REACHED || typeof resetsAt !== 'number' || !Number.isFinite(resetsAt))
    return null
  return new Date(resetsAt * MS_PER_SECOND).toISOString()
}

export function usageLimitDetail(cardId: number, session: string, reset: string): string {
  return `${USAGE_LIMIT}: card #${cardId} session ${session} hit the account's usage limit and left no shift report; the limit resets at ${reset}, no session starts before then, and the card is launched again after it with no fault and nothing taken from its requeue budget`
}

export function usageLimitResetIn(detail: string): string | null {
  return RESETS_AT.exec(detail)?.[1] ?? null
}

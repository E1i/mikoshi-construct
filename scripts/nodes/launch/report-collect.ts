import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { messageOf } from '../../core/errors.js'
import { exitCodePath, treeReportPath } from '../../core/places.js'

export const REPORT_MISSING = 'report-missing'

export type ReportCollection
  = | { kind: 'collected', tree: string, saved: string }
    | { kind: 'absent', tree: string }
    | { kind: 'unreadable', tree: string, reason: string }

function removeFromTree(tree: string): void {
  rmSync(tree, { recursive: true, force: true })
}

export function collectReport(worktree: string, saved: string): ReportCollection {
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

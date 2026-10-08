import type { ReportFormat } from '../../model/schema.js'
import type { Failure, ReportUnreadable, TestReport } from '../../model/test-report.js'
import type { Prediction } from './lines.js'
import type { MutationRecord } from './record.js'
import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { failuresOf, readTestReport, testCount, testsNamed, wasExecuted } from '../../model/test-report.js'
import { cardId, journalJudged } from './journal.js'
import { copyPath, forgetMutation, isSafeId, readCopy, readMutationRecord, sha256, writeBaseline } from './record.js'

export interface JudgeOptions {
  dir: string
  report?: string
  id?: string
  baseline?: boolean
  format?: ReportFormat
  card?: string
  journal?: string
  shiftCard?: string
}

export type JudgeRefusal
  = | 'no-mode'
    | 'report-unreadable'
    | 'report-red'
    | 'report-empty'
    | 'report-no-test'
    | 'unsafe-id'
    | 'no-record'
    | 'named-test-missing'
    | 'named-test-ambiguous'
    | 'named-test-skipped'
    | 'bad-card'
    | 'no-journal'
    | 'card-required'

export type HardFailureCause = 'file-changed' | 'copy-unreadable' | 'restore-failed'

export type Outcome = 'named-red' | 'other-red' | 'nothing-red'

export interface ReportSeen {
  path: string
  startTime: number
}

export type JudgeResult
  = | { status: 'baseline-recorded', report: ReportSeen, tests: number }
    | { status: 'refused', refusal: JudgeRefusal, detail: string, failures: Failure[] }
    | { status: 'hard-failure', id: string, file: string, cause: HardFailureCause, copy: string }
    | { status: 'no-witness', id: string, file: string, reason: string }
    | { status: 'judged', id: string, file: string, prediction: Prediction, outcome: Outcome, matched: boolean, failures: Failure[], report: ReportSeen, journaled?: string }

function refused(refusal: JudgeRefusal, detail = '', failures: Failure[] = []): JudgeResult {
  return { status: 'refused', refusal, detail, failures }
}

type TimedReport = TestReport & { startTime: number }

function readReport(format: ReportFormat, root: string, reportPath: string): TimedReport | ReportUnreadable {
  const report = readTestReport(format, root, reportPath)
  if ('unreadable' in report)
    return report
  if (report.startTime == null)
    return { unreadable: 'the report names no run start time' }
  return { ...report, startTime: report.startTime }
}

export function recordBaseline(root: string, reportPath: string, format: ReportFormat = 'vitest-json'): JudgeResult {
  const report = readReport(format, root, reportPath)
  if ('unreadable' in report)
    return refused('report-unreadable', report.unreadable)
  const failures = failuresOf(report)
  if (failures.length > 0)
    return refused('report-red', String(failures.length), failures)
  const tests = testCount(report)
  if (tests === 0)
    return refused('report-empty')
  writeBaseline(root, { startTime: report.startTime, recordedAt: Date.now(), tests })
  return { status: 'baseline-recorded', report: { path: reportPath, startTime: report.startTime }, tests }
}

function currentSha(file: string): string | null {
  try {
    return sha256(readFileSync(file))
  }
  catch {
    return null
  }
}

function restored(root: string, record: MutationRecord, target: string): HardFailureCause | null {
  const copy = readCopy(root, record.id)
  if (copy == null || sha256(copy) !== record.baselineSha)
    return 'copy-unreadable'
  try {
    writeFileSync(target, copy)
    if (!readFileSync(target).equals(copy))
      return 'restore-failed'
    if (typeof record.originalMtimeMs === 'number')
      utimesSync(target, new Date(), new Date(record.originalMtimeMs))
  }
  catch {
    return 'restore-failed'
  }
  return null
}

function outcomeOf(prediction: Prediction, report: TestReport, failures: Failure[]): { outcome: Outcome, matched: boolean } | JudgeResult {
  if (prediction.kind === 'green')
    return failures.length === 0 ? { outcome: 'nothing-red', matched: true } : { outcome: 'other-red', matched: false }
  const named = testsNamed(report, prediction.file, prediction.titles)
  if (named.length === 0)
    return refused('named-test-missing')
  if (named.length > 1)
    return refused('named-test-ambiguous', String(named.length))
  if (!named[0].ran && !named[0].failed)
    return refused('named-test-skipped')
  if (named[0].failed)
    return { outcome: 'named-red', matched: true }
  return { outcome: failures.length === 0 ? 'nothing-red' : 'other-red', matched: false }
}

export function judgeMutation(root: string, id: string, reportPath: string, format: ReportFormat = 'vitest-json'): JudgeResult {
  if (!isSafeId(id))
    return refused('unsafe-id', id)
  const record = readMutationRecord(root, id)
  if (record == null)
    return refused('no-record', id)
  const target = path.resolve(root, record.file)
  const hardFailure = (cause: HardFailureCause): JudgeResult => ({ status: 'hard-failure', id, file: record.file, cause, copy: copyPath(id) })

  if (currentSha(target) !== record.mutatedSha)
    return hardFailure('file-changed')

  const report = readReport(format, root, reportPath)
  const cause = restored(root, record, target)
  if (cause != null)
    return hardFailure(cause)
  forgetMutation(root, id)

  if ('unreadable' in report)
    return { status: 'no-witness', id, file: record.file, reason: report.unreadable }
  if (report.startTime < record.appliedAt)
    return { status: 'no-witness', id, file: record.file, reason: `the report started at ${report.startTime}, before the mutation was applied at ${record.appliedAt}` }

  if (!report.files.some(wasExecuted))
    return refused('report-no-test')

  const failures = failuresOf(report)
  const judged = outcomeOf(record.prediction, report, failures)
  if ('status' in judged)
    return judged
  return { status: 'judged', id, file: record.file, prediction: record.prediction, ...judged, failures, report: { path: reportPath, startTime: report.startTime } }
}

export function runJudge(options: JudgeOptions): JudgeResult {
  const root = path.resolve(options.dir)
  if (options.report == null || options.report === '')
    return refused('no-mode')
  const reportPath = path.resolve(options.report)
  const format = options.format ?? 'vitest-json'
  if (options.baseline === true && options.id == null)
    return recordBaseline(root, reportPath, format)
  if (options.baseline === true || options.id == null)
    return refused('no-mode')
  if (options.card == null && options.shiftCard != null && options.shiftCard !== '')
    return refused('card-required', options.shiftCard)
  if (options.card == null)
    return judgeMutation(root, options.id, reportPath, format)
  const card = cardId(options.card)
  if (card == null)
    return refused('bad-card', options.card)
  if (options.journal == null || options.journal === '')
    return refused('no-journal')
  const result = judgeMutation(root, options.id, reportPath, format)
  if (result.status !== 'judged')
    return result
  journalJudged(options.journal, { card, id: result.id, outcome: result.outcome, matched: result.matched }, new Date())
  return { ...result, journaled: options.journal }
}

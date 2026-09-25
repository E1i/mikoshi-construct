import type { Failure, TestReport } from '../../model/vitest-report.js'
import type { Prediction } from './lines.js'
import type { MutationRecord } from './record.js'
import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { failuresOf, readVitestReport, testCount, testsNamed } from '../../model/vitest-report.js'
import { copyPath, forgetMutation, isSafeId, readCopy, readMutationRecord, sha256, writeBaseline } from './record.js'

export interface JudgeOptions {
  dir: string
  report?: string
  id?: string
  baseline?: boolean
}

export type JudgeRefusal
  = | 'no-mode'
    | 'report-unreadable'
    | 'report-red'
    | 'report-empty'
    | 'unsafe-id'
    | 'no-record'
    | 'named-test-missing'
    | 'named-test-ambiguous'

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
    | { status: 'judged', id: string, file: string, prediction: Prediction, outcome: Outcome, matched: boolean, failures: Failure[], report: ReportSeen }

function refused(refusal: JudgeRefusal, detail = '', failures: Failure[] = []): JudgeResult {
  return { status: 'refused', refusal, detail, failures }
}

export function recordBaseline(root: string, reportPath: string): JudgeResult {
  const report = readVitestReport(root, reportPath)
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
  if (named[0].failed)
    return { outcome: 'named-red', matched: true }
  return { outcome: failures.length === 0 ? 'nothing-red' : 'other-red', matched: false }
}

export function judgeMutation(root: string, id: string, reportPath: string): JudgeResult {
  if (!isSafeId(id))
    return refused('unsafe-id', id)
  const record = readMutationRecord(root, id)
  if (record == null)
    return refused('no-record', id)
  const target = path.resolve(root, record.file)
  const hardFailure = (cause: HardFailureCause): JudgeResult => ({ status: 'hard-failure', id, file: record.file, cause, copy: copyPath(id) })

  if (currentSha(target) !== record.mutatedSha)
    return hardFailure('file-changed')

  const report = readVitestReport(root, reportPath)
  const cause = restored(root, record, target)
  if (cause != null)
    return hardFailure(cause)
  forgetMutation(root, id)

  if ('unreadable' in report)
    return { status: 'no-witness', id, file: record.file, reason: report.unreadable }
  if (report.startTime < record.appliedAt)
    return { status: 'no-witness', id, file: record.file, reason: `the report started at ${report.startTime}, before the mutation was applied at ${record.appliedAt}` }

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
  if (options.baseline === true && options.id == null)
    return recordBaseline(root, reportPath)
  if (options.baseline !== true && options.id != null)
    return judgeMutation(root, options.id, reportPath)
  return refused('no-mode')
}

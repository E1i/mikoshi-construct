import type { Ui } from '../../ui/console.js'
import type { Lore } from '../../ui/lore.js'
import type { ApplyRefusal, ApplyResult } from './apply.js'
import type { HardFailureCause, JudgeRefusal, JudgeResult } from './judge.js'
import type { Failure } from './vitest-report.js'
import { TEST_PATH_SEPARATOR } from './lines.js'
import { copyPath } from './record.js'

export { applyMutation } from './apply.js'
export { runJudge } from './judge.js'

export const MUTATE_JSON_SCHEMA_VERSION = 1

export const MUTATE_APPLY_EXIT = {
  applied: 0,
  refused: 1,
} as const

export const MUTATE_JUDGE_EXIT = {
  matched: 0,
  baselineRecorded: 0,
  refused: 1,
  unmatched: 2,
  noWitness: 2,
  hardFailure: 3,
} as const

type JudgeState = keyof typeof MUTATE_JUDGE_EXIT

const APPLY_REFUSAL_LINE: Record<ApplyRefusal, (lore: Lore, detail: string) => string> = {
  'no-baseline': lore => lore.mutateRefusedNoBaseline,
  'unsafe-id': (lore, detail) => lore.mutateRefusedUnsafeId(detail),
  'from-unreadable': (lore, detail) => lore.mutateRefusedFromUnreadable(detail),
  'unknown-id': (lore, detail) => lore.mutateRefusedUnknownId(detail),
  'duplicate-id': (lore, detail) => lore.mutateRefusedDuplicateId(detail),
  'malformed-line': (lore, detail) => lore.mutateRefusedMalformedLine(detail),
  'edit-line': lore => lore.mutateRefusedEditLine,
  'record-exists': (lore, detail) => lore.mutateRefusedRecordExists(detail),
  'outside-dir': (lore, detail) => lore.mutateRefusedOutsideDir(detail),
  'file-missing': (lore, detail) => lore.mutateRefusedFileMissing(detail),
  'changed-after-baseline': (lore, detail) => lore.mutateRefusedChangedAfterBaseline(detail),
  'find-count': (lore, detail) => lore.mutateRefusedFindCount(detail),
}

const JUDGE_REFUSAL_LINE: Record<JudgeRefusal, (lore: Lore, detail: string) => string> = {
  'no-mode': lore => lore.mutateRefusedNoMode,
  'report-unreadable': (lore, detail) => lore.mutateRefusedReportUnreadable(detail),
  'report-red': (lore, detail) => lore.mutateRefusedReportRed(detail),
  'report-empty': lore => lore.mutateRefusedReportEmpty,
  'unsafe-id': (lore, detail) => lore.mutateRefusedUnsafeId(detail),
  'no-record': (lore, detail) => lore.mutateRefusedNoRecord(detail),
  'named-test-missing': lore => lore.mutateRefusedNamedTestMissing,
  'named-test-ambiguous': (lore, detail) => lore.mutateRefusedNamedTestAmbiguous(detail),
}

const HARD_FAILURE_LINE: Record<HardFailureCause, (lore: Lore, file: string) => string> = {
  'file-changed': (lore, file) => lore.mutateHardFileChanged(file),
  'copy-unreadable': (lore, file) => lore.mutateHardCopyUnreadable(file),
  'restore-failed': (lore, file) => lore.mutateHardRestoreFailed(file),
}

export function testName(titles: string[]): string {
  return titles.join(TEST_PATH_SEPARATOR)
}

function failureJson(failure: Failure): { file: string, name: string | null } {
  return { file: failure.file, name: failure.titles == null ? null : testName(failure.titles) }
}

function failureLine(lore: Lore, failure: Failure): string {
  return failure.titles == null ? `${failure.file} ${lore.mutateFileFailedToRun}` : `${failure.file}${TEST_PATH_SEPARATOR}${testName(failure.titles)}`
}

export function applyExit(result: ApplyResult): number {
  return MUTATE_APPLY_EXIT[result.status]
}

export function applyJson(result: ApplyResult): Record<string, unknown> {
  if (result.status === 'refused')
    return { schemaVersion: MUTATE_JSON_SCHEMA_VERSION, state: 'refused', refusal: result.refusal, detail: result.detail }
  const { record } = result
  return {
    schemaVersion: MUTATE_JSON_SCHEMA_VERSION,
    state: 'applied',
    id: record.id,
    file: record.file,
    baselineSha: record.baselineSha,
    mutatedSha: record.mutatedSha,
    appliedAt: record.appliedAt,
    copy: copyPath(record.id),
    prediction: record.prediction,
  }
}

export function printApply(ui: Ui, result: ApplyResult): number {
  if (result.status === 'refused') {
    ui.flatline(APPLY_REFUSAL_LINE[result.refusal](ui.lore, result.detail))
    return applyExit(result)
  }
  ui.ok(ui.lore.mutateApplied(result.record.id, result.record.file))
  ui.line(ui.theme.dim(`  ${ui.lore.mutateApplyNext(result.record.id)}`))
  return applyExit(result)
}

export function judgeState(result: JudgeResult): JudgeState {
  switch (result.status) {
    case 'baseline-recorded': return 'baselineRecorded'
    case 'refused': return 'refused'
    case 'hard-failure': return 'hardFailure'
    case 'no-witness': return 'noWitness'
    case 'judged': return result.matched ? 'matched' : 'unmatched'
  }
}

export function judgeExit(result: JudgeResult): number {
  return MUTATE_JUDGE_EXIT[judgeState(result)]
}

export function judgeJson(result: JudgeResult): Record<string, unknown> {
  const envelope = { schemaVersion: MUTATE_JSON_SCHEMA_VERSION, state: judgeState(result) }
  switch (result.status) {
    case 'baseline-recorded':
      return { ...envelope, report: result.report, tests: result.tests }
    case 'refused':
      return { ...envelope, refusal: result.refusal, detail: result.detail, failures: result.failures.map(failureJson) }
    case 'hard-failure':
      return { ...envelope, id: result.id, file: result.file, cause: result.cause, copy: result.copy }
    case 'no-witness':
      return { ...envelope, id: result.id, file: result.file, restored: true, reason: result.reason }
    case 'judged':
      return { ...envelope, id: result.id, file: result.file, restored: true, prediction: result.prediction, outcome: result.outcome, failures: result.failures.map(failureJson), report: result.report }
  }
}

function outcomeLine(lore: Lore, result: Extract<JudgeResult, { status: 'judged' }>): string {
  if (result.outcome === 'named-red')
    return lore.mutateNamedRed
  if (result.outcome === 'other-red')
    return lore.mutateOtherRed
  return result.prediction.kind === 'green' ? lore.mutateGreenHeld : lore.mutateNothingRed
}

export function printJudge(ui: Ui, result: JudgeResult): number {
  switch (result.status) {
    case 'baseline-recorded':
      ui.ok(ui.lore.mutateBaselineRecorded(result.tests))
      break
    case 'refused':
      ui.flatline(JUDGE_REFUSAL_LINE[result.refusal](ui.lore, result.detail))
      for (const failure of result.failures)
        ui.line(`    ${ui.theme.dim(failureLine(ui.lore, failure))}`)
      break
    case 'hard-failure':
      ui.flatline(HARD_FAILURE_LINE[result.cause](ui.lore, result.file))
      ui.line(ui.lore.mutateCopyKept(result.copy))
      break
    case 'no-witness':
      ui.line(ui.lore.mutateRestored(result.file))
      ui.glitch(ui.lore.mutateNoWitness(result.reason))
      break
    case 'judged':
      ui.line(ui.lore.mutateRestored(result.file))
      ui.line(outcomeLine(ui.lore, result))
      for (const failure of result.failures)
        ui.line(`    ${ui.theme.dim(failureLine(ui.lore, failure))}`)
      ui.line(ui.theme.dim(ui.lore.mutateRestsOn(result.report.path, new Date(result.report.startTime).toISOString())))
      if (result.matched)
        ui.ok(ui.lore.mutateMatched)
      else
        ui.glitch(ui.lore.mutateUnmatched)
      break
  }
  return judgeExit(result)
}

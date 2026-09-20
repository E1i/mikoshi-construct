import type { DoctorResult } from './index.js'

export const RESULT_FAMILIES = ['knowledge', 'provenance'] as const
export type ResultFamily = (typeof RESULT_FAMILIES)[number]

export const DOCTOR_FIELD_FAMILY: Record<keyof DoctorResult, ResultFamily> = {
  ok: 'provenance',
  missingFiles: 'provenance',
  modifiedFiles: 'provenance',
  unreadableFiles: 'provenance',
  missingDiscovery: 'provenance',
  provenance: 'provenance',
  harnessProblems: 'provenance',
  uncollectedTests: 'provenance',
  warnings: 'provenance',
  checks: 'knowledge',
  youAreHere: 'knowledge',
  versionGap: 'provenance',
}

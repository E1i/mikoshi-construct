import type { DoctorResult } from './index.js'

export const RESULT_FAMILIES = ['knowledge', 'provenance'] as const
export type ResultFamily = (typeof RESULT_FAMILIES)[number]

export const DOCTOR_FIELD_FAMILY = {
  ok: 'provenance',
  missingFiles: 'provenance',
  modifiedFiles: 'provenance',
  unreadableFiles: 'provenance',
  missingDiscovery: 'provenance',
  provenance: 'provenance',
  harness: 'provenance',
  harnessProblems: 'provenance',
  uncollectedTests: 'provenance',
  warnings: 'provenance',
  checks: 'knowledge',
  hypotheses: 'knowledge',
  youAreHere: 'knowledge',
  notCarried: 'knowledge',
  versionGap: 'provenance',
} as const satisfies Record<keyof DoctorResult, ResultFamily>

export const RETIRED_IDENTIFIERS = ['red-gate', 'hook', 'construct-tests', 'weakestLink'] as const

export type ProvenanceField = {
  [K in keyof typeof DOCTOR_FIELD_FAMILY]: (typeof DOCTOR_FIELD_FAMILY)[K] extends 'provenance' ? K : never
}[keyof typeof DOCTOR_FIELD_FAMILY]

export type ProvenanceEvidence = Omit<Pick<DoctorResult, ProvenanceField>, 'ok'>

export function isIntact(evidence: ProvenanceEvidence): boolean {
  return evidence.missingFiles.length === 0 && evidence.harnessProblems.length === 0 && evidence.unreadableFiles.length === 0
}

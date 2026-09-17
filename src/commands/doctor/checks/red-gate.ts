import type { DoctorEvidence } from '../evidence.js'
import type { CheckVerdict } from '../verdict.js'
import { reached } from '../enforcement.js'

const ID = 'red-gate'

export function redGateCheck(evidence: DoctorEvidence): CheckVerdict {
  return reached(ID, 'unknown', evidence, `doctor executes nothing from the repository it inspects, so whether "${evidence.harness.command}" passes on a clean checkout is unproven here; CI is where that is proven`)
}

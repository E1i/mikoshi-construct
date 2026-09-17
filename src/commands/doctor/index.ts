import type { DiscoveryMarker } from '../../manifest.js'
import type { CheckVerdict, WeakestLink } from './verdict.js'
import { readManifest } from '../../manifest.js'
import { baselineVerdict } from './baseline.js'
import { ciCheck } from './checks/ci.js'
import { constructTestsCheck } from './checks/construct-tests.js'
import { hookCheck } from './checks/hook.js'
import { lintPolicyCheck } from './checks/lint-policy.js'
import { redGateCheck } from './checks/red-gate.js'
import { missingDiscovery } from './discovery.js'
import { gatherEvidence } from './evidence.js'
import { harnessProblems } from './harness.js'
import { typecheckWarnings } from './typecheck.js'
import { weakestLink } from './verdict.js'

export interface DoctorResult {
  ok: boolean
  missingFiles: string[]
  modifiedFiles: string[]
  missingDiscovery: DiscoveryMarker[]
  harnessProblems: string[]
  warnings: string[]
  checks: CheckVerdict[]
  weakestLink: WeakestLink | null
}

export function runDoctor(root: string): DoctorResult | null {
  const manifest = readManifest(root)
  if (manifest == null)
    return null

  const evidence = gatherEvidence(root, manifest)
  const baseline = baselineVerdict(root, manifest)
  const problems = harnessProblems(root, manifest, evidence.harness)
  const checks = [
    lintPolicyCheck(evidence),
    constructTestsCheck(evidence),
    ciCheck(evidence),
    hookCheck(evidence),
    redGateCheck(evidence),
  ]

  return {
    ok: baseline.missingFiles.length === 0 && problems.length === 0,
    missingFiles: baseline.missingFiles,
    modifiedFiles: baseline.modifiedFiles,
    missingDiscovery: missingDiscovery(root, manifest),
    harnessProblems: problems,
    warnings: typecheckWarnings(manifest.preset, evidence),
    checks,
    weakestLink: weakestLink(checks),
  }
}

export { DISCOVERY_PLACEHOLDER, isMarkerFilled, markerClose, markerOpen } from './discovery.js'
export { printDoctor } from './report.js'
export type { CheckId, CheckState, CheckVerdict, Level, WeakestLink } from './verdict.js'
export { CHECK_IDS, LEVELS, weakestLink } from './verdict.js'

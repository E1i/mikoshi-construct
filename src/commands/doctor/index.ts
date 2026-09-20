import type { DiscoveryMarker } from '../../manifest.js'
import type { SelectedPath } from '../../model/path.js'
import type { MarkerReading } from './provenance.js'
import type { CheckVerdict } from './verdict.js'
import type { VersionGap } from './version-gap.js'
import { readManifest } from '../../manifest.js'
import { readModel } from '../../model/write.js'
import { VERSION } from '../../version.js'
import { baselineVerdict } from './baseline.js'
import { missingDiscovery } from './discovery.js'
import { harnessProblems, readHarnessFacts } from './harness.js'
import { projectKnowledge } from './projection.js'
import { discoveryProvenance } from './provenance.js'
import { typecheckWarnings } from './typecheck.js'
import { uncollectedTests } from './uncollected-tests.js'
import { versionGap } from './version-gap.js'

export interface DoctorResult {
  ok: boolean
  missingFiles: string[]
  modifiedFiles: string[]
  missingDiscovery: DiscoveryMarker[]
  provenance: MarkerReading[]
  harnessProblems: string[]
  uncollectedTests: string[]
  warnings: string[]
  checks: CheckVerdict[]
  youAreHere: SelectedPath | null
  versionGap: VersionGap
}

export function runDoctor(root: string, version: string = VERSION): DoctorResult | null {
  const manifest = readManifest(root)
  if (manifest == null)
    return null

  const harness = readHarnessFacts(root, manifest.harness.command)
  const baseline = baselineVerdict(root, manifest)
  const problems = harnessProblems(root, manifest, harness)
  const knowledge = projectKnowledge(readModel(root), root)

  return {
    ok: baseline.missingFiles.length === 0 && problems.length === 0,
    missingFiles: baseline.missingFiles,
    modifiedFiles: baseline.modifiedFiles,
    missingDiscovery: missingDiscovery(root, manifest),
    provenance: discoveryProvenance(root, manifest),
    harnessProblems: problems,
    uncollectedTests: uncollectedTests(root, manifest),
    warnings: typecheckWarnings(manifest.preset, harness),
    checks: knowledge.checks,
    youAreHere: knowledge.youAreHere,
    versionGap: versionGap(root, manifest, version),
  }
}

export { DISCOVERY_PLACEHOLDER, isMarkerFilled, markerClose, markerOpen } from './discovery.js'
export type { ResultFamily } from './families.js'
export { DOCTOR_FIELD_FAMILY, RESULT_FAMILIES } from './families.js'
export type { KnowledgeProjection } from './projection.js'
export { projectKnowledge } from './projection.js'
export type { MarkerAuthorship, MarkerReading } from './provenance.js'
export { constructAuthored, discoveryProvenance, markerAuthorship } from './provenance.js'
export { printDoctor } from './report.js'
export type { CheckState, CheckVerdict, Level } from './verdict.js'
export { LEVELS } from './verdict.js'
export type { VersionGap } from './version-gap.js'
export { versionGap } from './version-gap.js'

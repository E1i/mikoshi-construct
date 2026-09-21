import type { DiscoveryMarker } from '../../manifest.js'
import type { ProvenanceEvidence } from './families.js'
import type { ClaimPlacement } from './projection.js'
import type { MarkerReading } from './provenance.js'
import type { CheckVerdict } from './verdict.js'
import type { VersionGap } from './version-gap.js'
import { readManifest } from '../../manifest.js'
import { readModel } from '../../model/write.js'
import { VERSION } from '../../version.js'
import { baselineVerdict } from './baseline.js'
import { missingDiscovery } from './discovery.js'
import { isIntact } from './families.js'
import { harnessProblems, readHarnessFacts } from './harness.js'
import { projectKnowledge } from './projection.js'
import { discoveryProvenance } from './provenance.js'
import { FileReadings } from './readings.js'
import { typecheckWarnings } from './typecheck.js'
import { uncollectedTests } from './uncollected-tests.js'
import { versionGap } from './version-gap.js'

export interface DoctorResult {
  ok: boolean
  missingFiles: string[]
  modifiedFiles: string[]
  unreadableFiles: string[]
  missingDiscovery: DiscoveryMarker[]
  provenance: MarkerReading[]
  harnessProblems: string[]
  uncollectedTests: string[]
  warnings: string[]
  checks: CheckVerdict[]
  youAreHere: ClaimPlacement
  versionGap: VersionGap
}

export function runDoctor(root: string, version: string = VERSION): DoctorResult | null {
  const manifest = readManifest(root)
  if (manifest == null)
    return null

  const readings = new FileReadings(root)
  const harness = readHarnessFacts(root, manifest.harness.command, readings)
  const baseline = baselineVerdict(root, manifest, readings)
  const problems = harnessProblems(root, manifest, harness, readings)
  const markers = missingDiscovery(root, manifest, readings)
  const provenance = discoveryProvenance(root, manifest, readings)
  const uncollected = uncollectedTests(root, manifest, readings)
  const knowledge = projectKnowledge(readModel(root), root)
  const unreadableFiles = readings.files
  const intact: ProvenanceEvidence = {
    missingFiles: baseline.missingFiles,
    modifiedFiles: baseline.modifiedFiles,
    unreadableFiles,
    missingDiscovery: markers,
    provenance,
    harnessProblems: problems,
    uncollectedTests: uncollected,
    warnings: typecheckWarnings(manifest.preset, harness),
    versionGap: versionGap(root, manifest, version),
  }

  return {
    ok: isIntact(intact),
    missingFiles: baseline.missingFiles,
    modifiedFiles: baseline.modifiedFiles,
    unreadableFiles,
    missingDiscovery: markers,
    provenance,
    harnessProblems: problems,
    uncollectedTests: uncollected,
    warnings: typecheckWarnings(manifest.preset, harness),
    checks: knowledge.checks,
    youAreHere: knowledge.youAreHere,
    versionGap: versionGap(root, manifest, version),
  }
}

export { DISCOVERY_PLACEHOLDER, isMarkerFilled, markerClose, markerOpen } from './discovery.js'
export type { ResultFamily } from './families.js'
export { DOCTOR_FIELD_FAMILY, RESULT_FAMILIES, RETIRED_IDENTIFIERS } from './families.js'
export type { ClaimPlacement, KnowledgeProjection, PlacementName } from './projection.js'
export { CLAIM_PLACEMENTS, projectKnowledge } from './projection.js'
export type { MarkerAuthorship, MarkerReading } from './provenance.js'
export { constructAuthored, discoveryProvenance, markerAuthorship } from './provenance.js'
export { FileReadings } from './readings.js'
export { printDoctor } from './report.js'
export type { CheckState, CheckVerdict, Level } from './verdict.js'
export { LEVELS } from './verdict.js'
export type { VersionGap } from './version-gap.js'
export { versionGap } from './version-gap.js'

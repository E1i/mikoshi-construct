import type { DiscoveryMarker } from '../../manifest.js'
import type { ProvenanceEvidence } from './families.js'
import type { HarnessReading } from './harness.js'
import type { ClaimNotCarried } from './not-carried.js'
import type { ClaimPlacement, HypothesisReading } from './projection.js'
import type { MarkerReading } from './provenance.js'
import type { CheckVerdict } from './verdict.js'
import type { VersionGap } from './version-gap.js'
import { readManifest, recordedShas } from '../../manifest.js'
import { authoredByOwner } from '../../model/ownership.js'
import { readModel } from '../../model/write.js'
import { VERSION } from '../../version.js'
import { baselineVerdict } from './baseline.js'
import { missingDiscovery } from './discovery.js'
import { isIntact } from './families.js'
import { HARNESS_COVERAGE_CLAIM, harnessProblems, harnessReading, readHarnessFacts } from './harness.js'
import { claimsNotCarried } from './not-carried.js'
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
  harness: HarnessReading
  harnessProblems: string[]
  uncollectedTests: string[]
  warnings: string[]
  checks: CheckVerdict[]
  hypotheses: HypothesisReading[]
  youAreHere: ClaimPlacement
  notCarried: ClaimNotCarried[]
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
  const model = readModel(root)
  const knowledge = projectKnowledge(model, root, authoredByOwner, { reports: 'read', constructPaths: Object.keys(recordedShas(manifest)) })
  const harnessState = harnessReading(manifest.harness.command, knowledge.stages[HARNESS_COVERAGE_CLAIM]?.verification)
  const unreadableFiles = readings.files
  const intact: ProvenanceEvidence = {
    missingFiles: baseline.missingFiles,
    modifiedFiles: baseline.modifiedFiles,
    unreadableFiles,
    missingDiscovery: markers,
    provenance,
    harness: harnessState,
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
    harness: harnessState,
    harnessProblems: problems,
    uncollectedTests: uncollected,
    warnings: typecheckWarnings(manifest.preset, harness),
    checks: knowledge.checks,
    hypotheses: knowledge.hypotheses,
    youAreHere: knowledge.youAreHere,
    notCarried: claimsNotCarried(root, manifest, model),
    versionGap: versionGap(root, manifest, version),
  }
}

export { DISCOVERY_PLACEHOLDER, isMarkerFilled, markerClose, markerOpen } from './discovery.js'
export type { ResultFamily } from './families.js'
export { DOCTOR_FIELD_FAMILY, RESULT_FAMILIES, RETIRED_IDENTIFIERS } from './families.js'
export type { ClaimNotCarried, NotCarriedReading } from './not-carried.js'
export { claimsNotCarried, NOT_CARRIED_READINGS } from './not-carried.js'
export type { ClaimPlacement, HypothesisReading, KnowledgeProjection, PlacementName } from './projection.js'
export { CLAIM_PLACEMENTS, projectKnowledge } from './projection.js'
export type { MarkerAuthorship, MarkerReading } from './provenance.js'
export { discoveryProvenance, MARKER_AUTHORSHIP, markerAuthorship, readingsBy } from './provenance.js'
export { FileReadings } from './readings.js'
export { DOCTOR_EXIT, DOCTOR_JSON_SCHEMA_VERSION, doctorJson, printDoctor } from './report.js'
export type { CheckState, CheckVerdict, Level } from './verdict.js'
export { LEVELS } from './verdict.js'
export type { VersionGap } from './version-gap.js'
export { versionGap } from './version-gap.js'

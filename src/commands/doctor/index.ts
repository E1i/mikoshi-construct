import type { DiscoveryMarker } from '../../manifest.js'
import type { Ui } from '../../ui/console.js'
import type { CarriersReading } from '../attach/record.js'
import type { ProvenanceEvidence } from './families.js'
import type { HarnessReading, NoHarnessReading } from './harness.js'
import type { ClaimNotCarried } from './not-carried.js'
import type { ClaimPlacement, HypothesisReading } from './projection.js'
import type { MarkerReading } from './provenance.js'
import type { CheckVerdict } from './verdict.js'
import type { VersionGap } from './version-gap.js'
import { clientIdsWithNoAdapter, readManifest, recordedShas } from '../../manifest.js'
import { authoredByOwner } from '../../model/ownership.js'
import { readModel } from '../../model/write.js'
import { VERSION } from '../../version.js'
import { attachedVersionOf, carriersReading, NO_HARNESS, readAttachRecord } from '../attach/record.js'
import { baselineVerdict } from './baseline.js'
import { missingDiscovery } from './discovery.js'
import { isIntact } from './families.js'
import { HARNESS_COVERAGE_CLAIM, harnessProblems, harnessReading, NO_HARNESS_READING, readHarnessFacts } from './harness.js'
import { claimsNotCarried } from './not-carried.js'
import { projectKnowledge } from './projection.js'
import { discoveryProvenance } from './provenance.js'
import { FileReadings } from './readings.js'
import { printDoctor as printDoctorReport } from './report.js'
import { typecheckWarnings } from './typecheck.js'
import { uncollectedTests } from './uncollected-tests.js'
import { versionGap } from './version-gap.js'

export interface DoctorResult {
  ok: boolean
  missingFiles: string[]
  movedFiles: string[]
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
  unknownClients: string[]
}

export interface AttachedReport {
  state: 'attached'
  harness: HarnessReading | NoHarnessReading
  attachedVersion: string | null
  installedVersion: string
  carriers: CarriersReading
}

export function runDoctor(root: string, version: string = VERSION): DoctorResult | AttachedReport | null {
  const manifest = readManifest(root)
  if (manifest == null) {
    const record = readAttachRecord(root)
    if (record == null)
      return null
    const attachedVersion = attachedVersionOf(record)
    const versions = { attachedVersion, installedVersion: version, carriers: carriersReading(attachedVersion, version) }
    if (record.harness === NO_HARNESS)
      return { state: 'attached', harness: NO_HARNESS_READING, ...versions }
    const knowledge = projectKnowledge(readModel(root), root, authoredByOwner, { reports: 'read', constructPaths: [] })
    return { state: 'attached', harness: harnessReading(record.harness.command, knowledge.stages[HARNESS_COVERAGE_CLAIM]?.verification), ...versions }
  }

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
    movedFiles: baseline.movedFiles,
    modifiedFiles: baseline.modifiedFiles,
    unreadableFiles,
    missingDiscovery: markers,
    provenance,
    harness: harnessState,
    harnessProblems: problems,
    uncollectedTests: uncollected,
    warnings: typecheckWarnings(manifest.preset, harness),
    versionGap: versionGap(root, manifest, version),
    unknownClients: clientIdsWithNoAdapter(manifest.client),
  }

  return {
    ok: isIntact(intact),
    missingFiles: baseline.missingFiles,
    movedFiles: baseline.movedFiles,
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
    unknownClients: clientIdsWithNoAdapter(manifest.client),
  }
}

function carriersLine(ui: Ui, report: AttachedReport): string | null {
  switch (report.carriers) {
    case 'current':
      return null
    case 'unknown':
      return ui.lore.doctorCarriersUnknown
    case 'stale':
      return ui.lore.doctorCarriersStale(report.attachedVersion ?? '', report.installedVersion)
    case 'ahead':
      return ui.lore.doctorCarriersAhead(report.attachedVersion ?? '', report.installedVersion)
  }
}

export function printDoctor(ui: Ui, result: DoctorResult | AttachedReport | null): number {
  const exit = printDoctorReport(ui, result)
  if (result != null && 'state' in result) {
    ui.line(ui.theme.dim(`  ${ui.lore.doctorAttachedVersions(result.attachedVersion, result.installedVersion)}`))
    const carriers = carriersLine(ui, result)
    if (carriers != null)
      ui.line(`  ${carriers}`)
  }
  return exit
}

export { DISCOVERY_PLACEHOLDER, isMarkerFilled, markerClose, markerOpen } from './discovery.js'
export type { FactoryChecklist, FactoryItem, FactoryItemName, FactorySituation } from './factory.js'
export { FACTORY_ITEMS, factoryChecklist } from './factory.js'
export type { ResultFamily } from './families.js'
export { DOCTOR_FIELD_FAMILY, RESULT_FAMILIES, RETIRED_IDENTIFIERS } from './families.js'
export type { ClaimNotCarried, NotCarriedReading } from './not-carried.js'
export { claimsNotCarried, NOT_CARRIED_READINGS } from './not-carried.js'
export type { ClaimPlacement, HypothesisReading, KnowledgeProjection, PlacementName } from './projection.js'
export { CLAIM_PLACEMENTS, projectKnowledge } from './projection.js'
export type { MarkerAuthorship, MarkerReading } from './provenance.js'
export { discoveryProvenance, MARKER_AUTHORSHIP, markerAuthorship, readingsBy } from './provenance.js'
export { FileReadings } from './readings.js'
export { DOCTOR_EXIT, DOCTOR_JSON_SCHEMA_VERSION, doctorJson, factoryChecklistExit, factoryChecklistJson, printFactoryChecklist } from './report.js'
export type { CheckState, CheckVerdict, Level } from './verdict.js'
export { LEVELS } from './verdict.js'
export type { VersionGap } from './version-gap.js'
export { versionGap } from './version-gap.js'

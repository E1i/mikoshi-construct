import type { SelectedPath } from '../../model/path.js'
import type { Ui } from '../../ui/console.js'
import type { DoctorResult } from './index.js'
import type { ClaimNotCarried } from './not-carried.js'
import type { ClaimPlacement, HypothesisReading } from './projection.js'
import type { MarkerAuthorship, MarkerReading } from './provenance.js'
import type { CheckVerdict } from './verdict.js'
import type { VersionGap } from './version-gap.js'
import { MARKER_AUTHORSHIP, readingsBy } from './provenance.js'

export const DOCTOR_EXIT = {
  ok: 0,
  notOk: 1,
  noManifest: 1,
} as const

export const DOCTOR_JSON_SCHEMA_VERSION = 1

export function doctorJson(result: DoctorResult | null): Record<string, unknown> {
  if (result == null)
    return { schemaVersion: DOCTOR_JSON_SCHEMA_VERSION, state: 'no-manifest' }
  return { schemaVersion: DOCTOR_JSON_SCHEMA_VERSION, ...result }
}

function reading(ui: Ui, check: CheckVerdict): string {
  switch (check.state) {
    case 'held':
      return ui.lore.verdictHeld(check.mechanism)
    case 'unsupported':
      return ui.lore.verdictUnsupported(check.mechanism, check.doesNotHold)
    case 'unknown':
      return check.reason === 'unevaluable'
        ? ui.lore.verdictUnevaluable(check.mechanism, check.unevaluable)
        : ui.lore.verdictNothingNamed(check.mechanism)
  }
}

function checkLine(ui: Ui, check: CheckVerdict, width: number): string {
  return `  ${check.id.padEnd(width)} ${check.level}  ${check.state.padEnd(12)} ${ui.theme.dim(reading(ui, check))}`
}

function claimsRead(ui: Ui, placement: ClaimPlacement): string | null {
  switch (placement.at) {
    case 'no-model':
      return ui.lore.enforcementNoModel
    case 'no-claim':
      return ui.lore.enforcementNoClaim
    default:
      return null
  }
}

function printChecks(ui: Ui, checks: CheckVerdict[], placement: ClaimPlacement): void {
  const width = Math.max(16, ...checks.map(check => check.id.length))
  ui.line()
  ui.line(ui.theme.accent(ui.lore.enforcement))
  const read = claimsRead(ui, placement)
  if (read != null)
    ui.line(ui.theme.dim(`  ${read}`))
  if (placement.at === 'no-model')
    ui.line(ui.theme.dim(`  ${ui.lore.modelIsWrittenByInit}`))
  for (const check of checks)
    ui.line(checkLine(ui, check, width))
  ui.line(ui.theme.dim(`  ${ui.lore.executesNothing}`))
}

function notCarriedLine(ui: Ui, claim: ClaimNotCarried): string {
  switch (claim.reading) {
    case 'does-not-hold':
      return ui.lore.notCarriedDoesNotHold(claim.claimId, claim.path)
    case 'unevaluable':
      return ui.lore.notCarriedUnevaluable(claim.claimId, claim.path)
    case 'every-fact-holds':
      return ui.lore.notCarriedEveryFactHolds(claim.claimId)
    case 'sources-omitted':
      return ui.lore.notCarriedSourcesOmitted(claim.claimId)
  }
}

function printNotCarried(ui: Ui, notCarried: ClaimNotCarried[]): void {
  if (notCarried.length === 0)
    return
  ui.line()
  ui.line(ui.theme.dim(`  ${ui.lore.notCarried}`))
  for (const claim of notCarried)
    ui.line(ui.theme.dim(notCarriedLine(ui, claim)))
}

function hypothesisReading(ui: Ui, hypothesis: HypothesisReading): string {
  switch (hypothesis.state) {
    case 'held':
      return ui.lore.hypothesisHeld(hypothesis.statement)
    case 'unsupported':
      return ui.lore.hypothesisUnsupported(hypothesis.statement, hypothesis.doesNotHold)
    case 'unknown':
      return hypothesis.reason === 'unevaluable'
        ? ui.lore.hypothesisUnevaluable(hypothesis.statement, hypothesis.unevaluable)
        : ui.lore.hypothesisNothingNamed(hypothesis.statement)
  }
}

function hypothesisLine(ui: Ui, hypothesis: HypothesisReading, width: number): string {
  const evidence = hypothesis.evidenceClean ? '' : ` ${ui.lore.hypothesisUncommittedEvidence}`
  return `  ${hypothesis.hypothesisId.padEnd(width)} ${hypothesis.state.padEnd(12)} ${ui.theme.dim(`${hypothesisReading(ui, hypothesis)}${evidence}`)}`
}

function hypothesesRead(ui: Ui, hypotheses: HypothesisReading[], placement: ClaimPlacement): string | null {
  if (hypotheses.length > 0)
    return null
  return placement.at === 'no-model' ? ui.lore.hypothesesNoModel : ui.lore.hypothesesNoneNamed
}

function printHypotheses(ui: Ui, hypotheses: HypothesisReading[], placement: ClaimPlacement): void {
  const width = Math.max(16, ...hypotheses.map(hypothesis => hypothesis.hypothesisId.length))
  ui.line()
  ui.line(ui.theme.accent(ui.lore.hypotheses))
  const read = hypothesesRead(ui, hypotheses, placement)
  if (read != null)
    ui.line(ui.theme.dim(`  ${read}`))
  for (const hypothesis of hypotheses)
    ui.line(hypothesisLine(ui, hypothesis, width))
}

function markerRows(ui: Ui, readings: MarkerReading[]): string[] {
  return readings.map(reading => `  ${reading.marker.padEnd(20)} ${ui.theme.dim(reading.file)}`)
}

function countLine(ui: Ui, phrase: (count: number) => string, readings: MarkerReading[]): string[] {
  return [ui.theme.dim(`  ${phrase(readings.length)}`)]
}

const PROVENANCE_READINGS: Record<MarkerAuthorship, (ui: Ui, readings: MarkerReading[]) => string[]> = {
  construct: (ui, readings) => [...markerRows(ui, readings), ...countLine(ui, ui.lore.stillConstructAuthored, readings)],
  owner: (ui, readings) => [...markerRows(ui, readings), ...countLine(ui, ui.lore.ownerAuthored, readings)],
  unreadable: (ui, readings) => [...markerRows(ui, readings), ...countLine(ui, ui.lore.provenanceUnreadable, readings)],
  unrecorded: (ui, readings) => countLine(ui, ui.lore.noProvenanceRecorded, readings),
}

function provenanceLines(ui: Ui, provenance: MarkerReading[]): string[] {
  const byAuthorship = readingsBy(provenance)
  return MARKER_AUTHORSHIP.flatMap(authorship =>
    (byAuthorship[authorship].length === 0 ? [] : PROVENANCE_READINGS[authorship](ui, byAuthorship[authorship])),
  )
}

function printProvenance(ui: Ui, provenance: MarkerReading[]): void {
  const lines = provenanceLines(ui, provenance)
  if (lines.length === 0)
    return
  ui.line()
  ui.line(ui.theme.accent(ui.lore.provenance))
  for (const line of lines)
    ui.line(line)
}

function gapReading(ui: Ui, gap: VersionGap): string {
  if (gap.pending == null)
    return ui.lore.baselineGapUnknown
  return gap.pending === 0 ? ui.lore.baselineCurrent : ui.lore.baselineMoved(gap.pending)
}

function printVersionGap(ui: Ui, gap: VersionGap): void {
  ui.line(ui.theme.dim(`  ${ui.lore.syncVersionGap(gap.materializedBy, gap.readBy)}`))
  ui.line(ui.theme.dim(`  ${gapReading(ui, gap)}`))
}

function stoppedLine(ui: Ui, stop: SelectedPath): string {
  switch (stop.state) {
    case 'unsupported':
      return ui.lore.youAreHereUnsupported(stop.claimId, stop.stage, stop.doesNotHold)
    case 'unknown':
      return stop.reason === 'unevaluable'
        ? ui.lore.youAreHereUnevaluable(stop.claimId, stop.stage, stop.unevaluable)
        : ui.lore.youAreHereNothingNamed(stop.claimId, stop.stage)
  }
}

function placementLine(ui: Ui, placement: ClaimPlacement): string {
  switch (placement.at) {
    case 'stop':
      return stoppedLine(ui, placement.stop)
    case 'no-stop':
      return ui.lore.youAreHereNone
    case 'no-claim':
      return ui.lore.youAreHereNoClaim
    case 'no-model':
      return ui.lore.youAreHereNoModel
  }
}

function printYouAreHere(ui: Ui, placement: ClaimPlacement): void {
  ui.line()
  ui.line(ui.theme.bold(placementLine(ui, placement)))
}

export function printDoctor(ui: Ui, result: DoctorResult | null): number {
  if (result == null) {
    ui.flatline('No construct.json here. Run `construct init` first.')
    return DOCTOR_EXIT.noManifest
  }
  if (result.harnessProblems.length > 0)
    ui.glitch('Harness is broken.', result.harnessProblems)
  if (result.harness.state === 'does-not-cover')
    ui.glitch(ui.lore.harnessDoesNotCover(result.harness.command))
  if (result.harness.state === 'unknown')
    ui.line(ui.theme.dim(`  ${ui.lore.harnessCoverageUnknown(result.harness.command)}`))
  if (result.uncollectedTests.length > 0)
    ui.glitch(ui.lore.uncollectedTests, result.uncollectedTests)
  if (result.unreadableFiles.length > 0)
    ui.glitch(ui.lore.unreadableFiles, result.unreadableFiles)
  if (result.missingFiles.length > 0)
    ui.glitch('Baseline files are missing.', result.missingFiles)
  if (result.missingDiscovery.length > 0)
    ui.glitch(ui.lore.discoveryIncomplete, ['', 'Missing:', ...result.missingDiscovery.map(marker => `  ${marker}`), '', 'Run: claude → /construct-discover'])
  if (result.warnings.length > 0)
    ui.glitch(ui.lore.typecheckCaveat, result.warnings)
  if (result.modifiedFiles.length > 0)
    ui.line(ui.theme.dim(`  ${result.modifiedFiles.length} baseline files modified since init (expected once the project evolves).`))
  printVersionGap(ui, result.versionGap)
  if (result.ok)
    ui.ok(ui.lore.stable)
  printProvenance(ui, result.provenance)
  printChecks(ui, result.checks, result.youAreHere)
  printNotCarried(ui, result.notCarried)
  printHypotheses(ui, result.hypotheses, result.youAreHere)
  printYouAreHere(ui, result.youAreHere)
  return result.ok ? DOCTOR_EXIT.ok : DOCTOR_EXIT.notOk
}

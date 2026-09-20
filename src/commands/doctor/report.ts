import type { Ui } from '../../ui/console.js'
import type { DoctorResult } from './index.js'
import type { ClaimPlacement } from './projection.js'
import type { MarkerReading } from './provenance.js'
import type { CheckVerdict } from './verdict.js'
import type { VersionGap } from './version-gap.js'
import { constructAuthored } from './provenance.js'

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
  for (const check of checks)
    ui.line(checkLine(ui, check, width))
  ui.line(ui.theme.dim(`  ${ui.lore.executesNothing}`))
}

function printProvenance(ui: Ui, provenance: MarkerReading[]): void {
  const authored = constructAuthored(provenance)
  if (authored.length === 0)
    return
  ui.line()
  ui.line(ui.theme.accent(ui.lore.provenance))
  for (const reading of authored)
    ui.line(`  ${reading.marker.padEnd(20)} ${ui.theme.dim(reading.file)}`)
  ui.line(ui.theme.dim(`  ${ui.lore.stillConstructAuthored(authored.length)}`))
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

function placementLine(ui: Ui, placement: ClaimPlacement): string {
  switch (placement.at) {
    case 'stop':
      return ui.lore.youAreHere(placement.stop.claimId, placement.stop.stage, placement.stop.state)
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
    return 1
  }
  if (result.harnessProblems.length > 0)
    ui.glitch('Harness is broken.', result.harnessProblems)
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
  printYouAreHere(ui, result.youAreHere)
  return result.ok ? 0 : 1
}

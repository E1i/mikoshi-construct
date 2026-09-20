import type { SelectedPath } from '../../model/path.js'
import type { Ui } from '../../ui/console.js'
import type { DoctorResult } from './index.js'
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

function printChecks(ui: Ui, checks: CheckVerdict[]): void {
  const width = Math.max(16, ...checks.map(check => check.id.length))
  ui.line()
  ui.line(ui.theme.accent(ui.lore.enforcement))
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

function printYouAreHere(ui: Ui, youAreHere: SelectedPath | null): void {
  ui.line()
  if (youAreHere == null) {
    ui.line(ui.theme.bold(ui.lore.youAreHereNone))
    return
  }
  ui.line(ui.theme.bold(ui.lore.youAreHere(youAreHere.claimId, youAreHere.stage, youAreHere.state)))
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
  printChecks(ui, result.checks)
  printYouAreHere(ui, result.youAreHere)
  return result.ok ? 0 : 1
}

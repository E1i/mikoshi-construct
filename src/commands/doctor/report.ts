import type { Ui } from '../../ui/console.js'
import type { DoctorResult } from './index.js'
import type { MarkerReading } from './provenance.js'
import type { CheckVerdict, WeakestLink } from './verdict.js'
import { constructAuthored } from './provenance.js'

function checkLine(ui: Ui, check: CheckVerdict): string {
  return `  ${check.id.padEnd(16)} ${check.level}  ${check.state.padEnd(8)} ${ui.theme.dim(check.evidence)}`
}

function printChecks(ui: Ui, checks: CheckVerdict[]): void {
  ui.line()
  ui.line(ui.theme.accent(ui.lore.enforcement))
  for (const check of checks)
    ui.line(checkLine(ui, check))
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

function printWeakestLink(ui: Ui, weakest: WeakestLink | null): void {
  ui.line()
  if (weakest == null) {
    ui.line(ui.theme.bold(ui.lore.weakestLinkNone))
    return
  }
  const lift = ui.lore.levelLift[weakest.level]
  ui.line(`${ui.theme.bold(ui.lore.weakestLink(weakest.id, weakest.level))}${lift == null ? '' : ui.theme.dim(` — ${lift}`)}`)
}

export function printDoctor(ui: Ui, result: DoctorResult | null): number {
  if (result == null) {
    ui.flatline('No construct.json here. Run `construct init` first.')
    return 1
  }
  if (result.harnessProblems.length > 0)
    ui.glitch('Harness is broken.', result.harnessProblems)
  if (result.missingFiles.length > 0)
    ui.glitch('Baseline files are missing.', result.missingFiles)
  if (result.missingDiscovery.length > 0)
    ui.glitch(ui.lore.discoveryIncomplete, ['', 'Missing:', ...result.missingDiscovery.map(marker => `  ${marker}`), '', 'Run: claude → /construct-discover'])
  if (result.warnings.length > 0)
    ui.glitch(ui.lore.typecheckCaveat, result.warnings)
  if (result.modifiedFiles.length > 0)
    ui.line(ui.theme.dim(`  ${result.modifiedFiles.length} baseline files modified since init (expected once the project evolves).`))
  if (result.ok)
    ui.ok(ui.lore.stable)
  printProvenance(ui, result.provenance)
  printChecks(ui, result.checks)
  printWeakestLink(ui, result.weakestLink)
  return result.ok ? 0 : 1
}

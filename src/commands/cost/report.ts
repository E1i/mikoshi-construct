import type { Ui } from '../../ui/console.js'
import type { LedgerSummary, Reconciliation, TokenCount } from './ledger.js'
import type { CostReport, CostStatus } from './source.js'
import type { WorkflowRun } from './usage.js'
import { add, billable, emptyUsage, PRICE_RELATIVE_TO_INPUT, weighted } from './usage.js'

export const COST_EXIT: Record<CostStatus, number> = {
  ok: 0,
  empty: 0,
  mismatch: 1,
  unknown: 1,
  unsupported: 3,
}

function selectRuns(report: CostReport, last: boolean): WorkflowRun[] {
  const runs = report.runs ?? []
  return last ? runs.slice(-1) : runs
}

export function costJson(report: CostReport, last: boolean): Record<string, unknown> {
  const runs = selectRuns(report, last)
  return {
    status: report.status,
    runtime: report.runtime,
    version: report.version,
    ...(report.key == null ? {} : { key: report.key }),
    ...(report.candidates == null || report.candidates.length === 0 ? {} : { candidates: report.candidates }),
    ...(runs.length === 0 ? {} : { runs }),
    ...(report.ledger == null ? {} : { ledger: report.ledger }),
    ...(report.reconciliation == null ? {} : { reconciliation: report.reconciliation }),
  }
}

function fmt(value: number): string {
  return value.toLocaleString('en-US')
}

function tokens(value: TokenCount): string {
  return value === 'unknown' ? 'unknown' : fmt(value)
}

function printLedger(ui: Ui, ledger: LedgerSummary | undefined, reconciliation: Reconciliation | undefined): void {
  if (ledger == null && reconciliation == null)
    return
  if (ledger != null) {
    ui.line(ui.theme.dim(ui.lore.ledgerCounts(ledger.runs, ledger.agents, ledger.failures, tokens(ledger.tokens))))
    if (ledger.malformed.length > 0)
      ui.glitch(ui.lore.ledgerMalformed(ledger.malformed.length), ledger.malformed.map(entry => `line ${entry.line}: ${entry.reason}`))
  }
  if (reconciliation == null)
    return
  ui.line(ui.theme.dim(ui.lore.ledgerDrift(reconciliation.entriesWithoutSession.length, reconciliation.sessionsWithoutEntry.length, reconciliation.unjoinable)))
  for (const run of reconciliation.entriesWithoutSession)
    ui.line(ui.theme.dim(`    ${run}: ${ui.lore.ledgerEntryWithoutSession}`))
  for (const run of reconciliation.sessionsWithoutEntry)
    ui.line(ui.theme.dim(`    ${run}: ${ui.lore.ledgerSessionWithoutEntry}`))
}

function printRuns(ui: Ui, runs: WorkflowRun[]): void {
  const grand = emptyUsage()
  for (const run of runs) {
    ui.line(`${ui.theme.accent(run.run)} ${ui.theme.dim(`${run.startedAt} · ${run.total.models.join(', ')}`)}`)
    for (const agent of run.agents)
      ui.line(`  ${agent.type.padEnd(12)} ${agent.label.padEnd(28)} calls ${String(agent.usage.calls).padStart(3)}  in ${fmt(agent.usage.input).padStart(8)}  cache-w ${fmt(agent.usage.cacheWrite).padStart(9)}  cache-r ${fmt(agent.usage.cacheRead).padStart(10)}  out ${fmt(agent.usage.output).padStart(7)}`)
    ui.line(`  ${ui.theme.bold(`total ${fmt(billable(run.total))} billable tokens in ${run.total.calls} calls`)} ${ui.theme.dim(`≈ ${fmt(weighted(run.total))} input-equivalent`)}`)
    ui.line()
    add(grand, run.total)
  }
  if (runs.length > 1)
    ui.line(`${ui.theme.bold(`${runs.length} runs: ${fmt(billable(grand))} billable tokens in ${grand.calls} calls`)} ${ui.theme.dim(`≈ ${fmt(weighted(grand))} input-equivalent (cache-write ×${PRICE_RELATIVE_TO_INPUT.cacheWrite}, cache-read ×${PRICE_RELATIVE_TO_INPUT.cacheRead}, output ×${PRICE_RELATIVE_TO_INPUT.output})`)}`)
}

export function printCost(ui: Ui, report: CostReport, last: boolean): number {
  ui.line(ui.theme.dim(ui.lore.costMeasuredBy(report.version)))
  const key = report.key ?? ''
  const candidates = report.candidates ?? []
  switch (report.status) {
    case 'unsupported':
      ui.glitch(ui.lore.costUnsupported(report.runtime))
      break
    case 'mismatch':
      ui.glitch(ui.lore.costKeyMismatch(key), candidates)
      break
    case 'unknown':
      ui.glitch(ui.lore.costKeyUnknown(key), candidates)
      break
    case 'empty':
      ui.glitch(ui.lore.costEmpty)
      break
    case 'ok':
      printRuns(ui, selectRuns(report, last))
      break
  }
  printLedger(ui, report.ledger, report.reconciliation)
  return COST_EXIT[report.status]
}

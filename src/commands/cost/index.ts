import type { CostReport, CostSource } from './source.js'
import process from 'node:process'
import { VERSION } from '../../version.js'
import { ClaudeCodeCostSource } from './claude-code.js'
import { hasLedgerFindings, readLedger, reconcile, summarizeLedger, withoutTokenTotals } from './ledger.js'
import { resolveRuntime } from './runtime.js'

export { ClaudeCodeCostSource, claudeProjectsDir, collectWorkflowRuns, projectKey } from './claude-code.js'
export { LEDGER_FILE, readLedger, reconcile, summarizeLedger } from './ledger.js'
export type { LedgerEntry, LedgerSummary, MalformedLedgerLine, Reconciliation, TokenCount } from './ledger.js'
export { COST_EXIT, costJson, printCost } from './report.js'
export { resolveRuntime } from './runtime.js'
export type { CostReport, CostSource, CostStatus, Runtime } from './source.js'
export { billable, weighted } from './usage.js'
export type { AgentUsage, Usage, WorkflowRun } from './usage.js'

export function costReport(cwd: string, options: { projectsDir?: string, env?: NodeJS.ProcessEnv, version?: string } = {}): CostReport {
  const version = options.version ?? VERSION
  const runtime = resolveRuntime(cwd, options.env ?? process.env)
  const reading = readLedger(cwd)
  const ledger = summarizeLedger(reading)
  const reported = hasLedgerFindings(ledger)
  const source: CostSource | null = runtime === 'claude-code' ? new ClaudeCodeCostSource(options.projectsDir) : null
  if (source == null || !source.readable())
    return { status: 'unsupported', runtime, version, ...(reported ? { ledger: withoutTokenTotals(ledger) } : {}) }
  const result = source.read(cwd)
  const joinable = result.status === 'ok' || result.status === 'empty'
  return {
    runtime,
    version,
    ...result,
    ...(reported ? { ledger } : {}),
    ...(joinable && (reported || result.runs.length > 0) ? { reconciliation: reconcile(reading.entries, result.runs) } : {}),
  }
}

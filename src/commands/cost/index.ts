import type { CostReport, CostSource } from './source.js'
import type { StepCache } from './step-cache.js'
import process from 'node:process'
import { VERSION } from '../../version.js'
import { ClaudeCodeCostSource } from './claude-code.js'
import { hasLedgerFindings, readLedger, reconcile, summarizeLedger, withoutTokenTotals } from './ledger.js'
import { resolveRuntime } from './runtime.js'
import { knownRunSteps, readStepCache, recordRunSteps } from './step-cache.js'
import { readTurnJournal } from './turns.js'

export { ClaudeCodeCostSource, claudeProjectsDir, collectWorkflowRuns, projectKey } from './claude-code.js'
export { CAUSES, LEDGER_FILE, readLedger, reconcile, summarizeLedger, TOKEN_SOURCES } from './ledger.js'
export type { Cause, LedgerEntry, LedgerSummary, MalformedLedgerLine, Reconciliation, TokenCount, TokenSource } from './ledger.js'
export { COST_EXIT, COST_JSON_SCHEMA_VERSION, costJson, printCost } from './report.js'
export { resolveRuntime } from './runtime.js'
export type { CostReport, CostSource, CostStatus, Runtime } from './source.js'
export { readStepCache, STEP_CACHE_FILE } from './step-cache.js'
export type { StepCache } from './step-cache.js'
export { STEPS } from './steps.js'
export type { RunStep, Step } from './steps.js'
export { readTurnJournal, TURN_JOURNAL_FILE } from './turns.js'
export type { MalformedTurnLine, TurnSummary } from './turns.js'
export { billable, weighted } from './usage.js'
export type { AgentUsage, Usage, WorkflowRun } from './usage.js'

export function recordedSteps(cwd: string, runs: string[], source: CostSource | null): StepCache {
  return source != null && source.readable() ? recordRunSteps(cwd, runs, run => source.steps(run)) : readStepCache(cwd)
}

export function knownSteps(cwd: string, runs: string[], source: CostSource | null): StepCache {
  return source != null && source.readable() ? knownRunSteps(cwd, runs, run => source.steps(run)) : readStepCache(cwd)
}

export function costReport(cwd: string, options: { projectsDir?: string, env?: NodeJS.ProcessEnv, version?: string } = {}): CostReport {
  const version = options.version ?? VERSION
  const runtime = resolveRuntime(cwd, options.env ?? process.env)
  const reading = readLedger(cwd)
  const ledger = summarizeLedger(reading)
  const reported = hasLedgerFindings(ledger)
  const turns = readTurnJournal(cwd)
  const source: CostSource | null = runtime === 'claude-code' ? new ClaudeCodeCostSource(options.projectsDir) : null
  if (source == null || !source.readable())
    return { status: 'unsupported', runtime, version, turns, ...(reported ? { ledger: withoutTokenTotals(ledger) } : {}) }
  const ledgerRuns = reading.entries.map(entry => entry.run).filter(run => run != null)
  const result = source.read(cwd, ledgerRuns)
  recordedSteps(cwd, ledgerRuns, source)
  const joinable = result.status === 'ok' || result.status === 'empty'
  return {
    runtime,
    version,
    turns,
    ...result,
    ...(reported ? { ledger } : {}),
    ...(joinable && (reported || result.runs.length > 0) ? { reconciliation: reconcile(reading.entries, result.runs) } : {}),
  }
}

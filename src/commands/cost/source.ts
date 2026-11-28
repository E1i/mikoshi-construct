import type { CheapReading } from './cheap.js'
import type { LedgerSummary, Reconciliation } from './ledger.js'
import type { RunDecomposition } from './steps.js'
import type { TurnSummary } from './turns.js'
import type { WorkflowRun } from './usage.js'
import { ClaudeCodeCostSource } from './claude-code.js'

export { ClaudeCodeCostSource, claudeProjectsDir, collectWorkflowRuns, labelledAgentTokens, labelledTranscripts, projectKey, readAgentRecord } from './claude-code.js'

export type Runtime = 'claude-code' | 'cursor'

export type ReadingStatus = 'ok' | 'empty' | 'mismatch' | 'unknown'

export type CostStatus = ReadingStatus | 'unsupported'

export interface CostReading {
  status: ReadingStatus
  runs: WorkflowRun[]
  key: string
  candidates: string[]
}

export interface CostSource {
  runtime: Runtime
  readable: () => boolean
  read: (cwd: string, ledgerRuns: string[]) => CostReading
  steps: (run: string) => RunDecomposition | null
}

export function recordingSource(projectsDir?: string): CostSource {
  return new ClaudeCodeCostSource(projectsDir)
}

const COST_SOURCES: Partial<Record<Runtime, (projectsDir?: string) => CostSource>> = {
  'claude-code': recordingSource,
}

export function costSourceFor(runtime: Runtime, projectsDir?: string): CostSource | null {
  return COST_SOURCES[runtime]?.(projectsDir) ?? null
}

export interface CostReport {
  status: CostStatus
  runtime: Runtime
  version: string
  runs?: WorkflowRun[]
  key?: string
  candidates?: string[]
  ledger?: LedgerSummary
  reconciliation?: Reconciliation
  turns: TurnSummary
  cheap?: CheapReading
}

import type { LedgerSummary, Reconciliation } from './ledger.js'
import type { WorkflowRun } from './usage.js'

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
  read: (cwd: string) => CostReading
}

export interface CostReport {
  status: CostStatus
  runtime: Runtime
  runs?: WorkflowRun[]
  key?: string
  candidates?: string[]
  ledger?: LedgerSummary
  reconciliation?: Reconciliation
}

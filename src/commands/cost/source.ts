import type { Lore } from '../../ui/lore.js'
import type { CheapReading } from './cheap.js'
import type { LedgerSummary, Reconciliation } from './ledger.js'
import type { StepCache } from './step-cache.js'
import type { RunDecomposition, RunStep, UnreadAgent } from './steps.js'
import type { TurnSummary } from './turns.js'
import type { WorkflowRun } from './usage.js'
import { ClaudeCodeCostSource } from './claude-code.js'
import { knownRunSteps, readStepCache } from './step-cache.js'

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

function knownSteps(root: string, runs: string[], source: CostSource | null): StepCache {
  return source != null && source.readable() ? knownRunSteps(root, runs, run => source.steps(run)) : readStepCache(root)
}

function unreadWarnings(unread: UnreadAgent[], lore: Lore): string[] {
  const byRun = new Map<string, UnreadAgent[]>()
  for (const agent of unread)
    byRun.set(agent.run, [...byRun.get(agent.run) ?? [], agent])
  return [...byRun].map(([run, agents]) => lore.expectUnreadRun(run, agents.map(agent => lore.expectUnreadAgent(agent.agent, agent.reason)).join('; ')))
}

export function stepsOfRepository(root: string, runs: string[], warnings: string[], lore: Lore, source: CostSource | null): Map<string, RunStep[]> {
  const cache = knownSteps(root, runs, source)
  for (const line of cache.malformed)
    warnings.push(lore.expectStepCacheMalformed(line))
  warnings.push(...unreadWarnings(cache.unread, lore))
  return cache.runs
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

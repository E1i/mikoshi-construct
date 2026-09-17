import type { CostReport, CostSource } from './source.js'
import process from 'node:process'
import { ClaudeCodeCostSource } from './claude-code.js'
import { resolveRuntime } from './runtime.js'

export { ClaudeCodeCostSource, claudeProjectsDir, collectWorkflowRuns, projectKey } from './claude-code.js'
export { COST_EXIT, costJson, printCost } from './report.js'
export { resolveRuntime } from './runtime.js'
export type { CostReport, CostSource, CostStatus, Runtime } from './source.js'
export { billable, weighted } from './usage.js'
export type { AgentUsage, Usage, WorkflowRun } from './usage.js'

export function costReport(cwd: string, options: { projectsDir?: string, env?: NodeJS.ProcessEnv } = {}): CostReport {
  const runtime = resolveRuntime(cwd, options.env ?? process.env)
  const source: CostSource | null = runtime === 'claude-code' ? new ClaudeCodeCostSource(options.projectsDir) : null
  if (source == null || !source.readable())
    return { status: 'unsupported', runtime }
  return { runtime, ...source.read(cwd) }
}

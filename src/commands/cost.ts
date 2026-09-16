import type { Ui } from '../ui/console.js'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export interface Usage {
  calls: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  models: string[]
}

export interface AgentUsage {
  label: string
  type: string
  usage: Usage
}

export interface WorkflowRun {
  session: string
  run: string
  startedAt: string
  agents: AgentUsage[]
  total: Usage
}

interface SessionLine {
  message?: {
    role?: string
    model?: string
    usage?: {
      input_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      output_tokens?: number
    }
  }
}

function emptyUsage(): Usage {
  return { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, models: [] }
}

export function billable(usage: Usage): number {
  return usage.input + usage.cacheWrite + usage.cacheRead + usage.output
}

function add(total: Usage, part: Usage): void {
  total.calls += part.calls
  total.input += part.input
  total.cacheWrite += part.cacheWrite
  total.cacheRead += part.cacheRead
  total.output += part.output
  for (const model of part.models) {
    if (!total.models.includes(model))
      total.models.push(model)
  }
}

export function projectKey(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

export function claudeProjectsDir(): string {
  return path.join(homedir(), '.claude', 'projects')
}

function readUsage(file: string): Usage {
  const totals = emptyUsage()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('{'))
      continue
    let entry: SessionLine
    try {
      entry = JSON.parse(line) as SessionLine
    }
    catch {
      continue
    }
    const message = entry.message
    if (message?.role !== 'assistant' || message.usage == null)
      continue
    totals.calls += 1
    totals.input += message.usage.input_tokens ?? 0
    totals.cacheWrite += message.usage.cache_creation_input_tokens ?? 0
    totals.cacheRead += message.usage.cache_read_input_tokens ?? 0
    totals.output += message.usage.output_tokens ?? 0
    if (message.model != null && !totals.models.includes(message.model))
      totals.models.push(message.model)
  }
  return totals
}

function directories(parent: string): string[] {
  if (!existsSync(parent))
    return []
  return readdirSync(parent).map(name => path.join(parent, name)).filter(entry => statSync(entry).isDirectory())
}

function collectRuns(sessionDir: string): WorkflowRun[] {
  return directories(path.join(sessionDir, 'subagents', 'workflows')).map((dir) => {
    const agents = readdirSync(dir)
      .filter(file => file.startsWith('agent-') && file.endsWith('.jsonl'))
      .map((file) => {
        const metaPath = path.join(dir, file.replace(/\.jsonl$/, '.meta.json'))
        const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) as { description?: string, agentType?: string } : {}
        return { label: meta.description ?? path.basename(file), type: meta.agentType ?? '?', usage: readUsage(path.join(dir, file)) }
      })
    const total = emptyUsage()
    for (const agent of agents)
      add(total, agent.usage)
    return { session: path.basename(sessionDir), run: path.basename(dir), startedAt: statSync(dir).mtime.toISOString(), agents, total }
  })
}

export function collectWorkflowRuns(cwd: string, projectsDir = claudeProjectsDir()): WorkflowRun[] | null {
  const projectDir = path.join(projectsDir, projectKey(cwd))
  if (!existsSync(projectDir))
    return null
  return directories(projectDir)
    .flatMap(collectRuns)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

function fmt(value: number): string {
  return value.toLocaleString('en-US')
}

export function printCost(ui: Ui, runs: WorkflowRun[] | null, last: boolean): number {
  if (runs == null) {
    ui.flatline('No Claude Code session data for this directory.')
    return 1
  }
  const selected = last ? runs.slice(-1) : runs
  if (selected.length === 0) {
    ui.glitch('No /implement runs recorded here yet.')
    return 0
  }
  const grand = emptyUsage()
  for (const run of selected) {
    ui.line(`${ui.theme.accent(run.run)} ${ui.theme.dim(`${run.startedAt} · ${run.total.models.join(', ')}`)}`)
    for (const agent of run.agents) {
      ui.line(`  ${agent.type.padEnd(12)} ${agent.label.padEnd(28)} calls ${String(agent.usage.calls).padStart(3)}  in ${fmt(agent.usage.input).padStart(8)}  cache-w ${fmt(agent.usage.cacheWrite).padStart(9)}  cache-r ${fmt(agent.usage.cacheRead).padStart(10)}  out ${fmt(agent.usage.output).padStart(7)}`)
    }
    ui.line(`  ${ui.theme.bold(`total ${fmt(billable(run.total))} billable tokens in ${run.total.calls} calls`)}`)
    ui.line()
    add(grand, run.total)
  }
  if (selected.length > 1)
    ui.line(ui.theme.bold(`${selected.length} runs: ${fmt(billable(grand))} billable tokens in ${grand.calls} calls`))
  return 0
}

import type { CostReading, CostSource, Runtime } from './source.js'
import type { RunDecomposition, StepAgent } from './steps.js'
import type { Usage, WorkflowRun } from './usage.js'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { stepsOf } from './steps.js'
import { add, emptyUsage } from './usage.js'

interface SessionLine {
  requestId?: string
  timestamp?: string
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

export function projectKey(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

export function claudeProjectsDir(): string {
  return path.join(homedir(), '.claude', 'projects')
}

export interface AgentRecord {
  usage: Usage
  first: string | null
  last: string | null
}

interface AgentMeta {
  description?: string
  agentType?: string
  workflowPhase?: string
}

export function readAgentRecord(file: string): AgentRecord {
  const totals = emptyUsage()
  const counted = new Set<string>()
  const stamps: string[] = []
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
    if (typeof entry.timestamp === 'string')
      stamps.push(entry.timestamp)
    const message = entry.message
    if (message?.role !== 'assistant' || message.usage == null)
      continue
    if (entry.requestId != null) {
      if (counted.has(entry.requestId))
        continue
      counted.add(entry.requestId)
    }
    totals.calls += 1
    totals.input += message.usage.input_tokens ?? 0
    totals.cacheWrite += message.usage.cache_creation_input_tokens ?? 0
    totals.cacheRead += message.usage.cache_read_input_tokens ?? 0
    totals.output += message.usage.output_tokens ?? 0
    if (message.model != null && !totals.models.includes(message.model))
      totals.models.push(message.model)
  }
  const ordered = stamps.sort((a, b) => Date.parse(a) - Date.parse(b))
  return { usage: totals, first: ordered[0] ?? null, last: ordered.at(-1) ?? null }
}

function directories(parent: string): string[] {
  if (!existsSync(parent))
    return []
  return readdirSync(parent).map(name => path.join(parent, name)).filter(entry => statSync(entry).isDirectory())
}

function workflowsDir(sessionDir: string): string {
  return path.join(sessionDir, 'subagents', 'workflows')
}

function collectRuns(sessionDir: string): WorkflowRun[] {
  return directories(workflowsDir(sessionDir)).map(dir => runOf(sessionDir, dir))
}

function agentsIn(dir: string): StepAgent[] {
  return readdirSync(dir)
    .filter(file => file.startsWith('agent-') && file.endsWith('.jsonl'))
    .map((file) => {
      const metaPath = path.join(dir, file.replace(/\.jsonl$/, '.meta.json'))
      const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) as AgentMeta : {}
      return { label: meta.description ?? path.basename(file), type: meta.agentType ?? '?', phase: meta.workflowPhase ?? null, ...readAgentRecord(path.join(dir, file)) }
    })
}

function runOf(sessionDir: string, dir: string): WorkflowRun {
  const agents = agentsIn(dir).map(({ label, type, usage }) => ({ label, type, usage }))
  const total = emptyUsage()
  for (const agent of agents)
    add(total, agent.usage)
  return { session: path.basename(sessionDir), run: path.basename(dir), startedAt: statSync(dir).mtime.toISOString(), agents, total }
}

function runDirsNamed(run: string, projectsDir: string): string[] {
  return directories(projectsDir)
    .flatMap(directories)
    .map(session => path.join(workflowsDir(session), run))
    .filter(dir => existsSync(dir))
}

function byStart(a: WorkflowRun, b: WorkflowRun): number {
  return a.startedAt.localeCompare(b.startedAt)
}

function runsNamedUnderOtherKeys(named: string[], key: string, projectsDir: string): WorkflowRun[] {
  if (named.length === 0)
    return []
  return directories(projectsDir)
    .filter(project => path.basename(project) !== key)
    .flatMap(directories)
    .flatMap(session => named
      .map(run => path.join(workflowsDir(session), run))
      .filter(dir => existsSync(dir))
      .map(dir => runOf(session, dir)))
}

export function collectWorkflowRuns(cwd: string, projectsDir = claudeProjectsDir()): WorkflowRun[] {
  return directories(path.join(projectsDir, projectKey(cwd)))
    .flatMap(collectRuns)
    .sort(byStart)
}

function resolvedPath(cwd: string): string | null {
  try {
    return realpathSync(cwd)
  }
  catch {
    return null
  }
}

function mainWorktreePath(cwd: string): string | null {
  const dotGit = path.join(cwd, '.git')
  if (!existsSync(dotGit) || !statSync(dotGit).isFile())
    return null
  const gitdir = readFileSync(dotGit, 'utf8').match(/^gitdir: *(\S.*)$/m)?.[1]?.trim()
  return gitdir?.match(/^(.+)\/\.git\/worktrees\/[^/]+\/?$/)?.[1] ?? null
}

function recordedElsewhere(cwd: string, key: string, projectsDir: string): string[] {
  return [resolvedPath(cwd), mainWorktreePath(cwd)]
    .filter((candidate): candidate is string => candidate != null)
    .map(projectKey)
    .filter(candidate => candidate !== key && existsSync(path.join(projectsDir, candidate)))
}

function lookalikeKeys(cwd: string, key: string, projectsDir: string): string[] {
  const suffix = `-${path.basename(cwd)}`
  return directories(projectsDir)
    .map(dir => path.basename(dir))
    .filter(name => name !== key && name.endsWith(suffix))
}

export class ClaudeCodeCostSource implements CostSource {
  readonly runtime: Runtime = 'claude-code'

  constructor(private readonly projectsDir: string = claudeProjectsDir()) {}

  readable(): boolean {
    return existsSync(this.projectsDir)
  }

  read(cwd: string, ledgerRuns: string[] = []): CostReading {
    const key = projectKey(cwd)
    const own = collectWorkflowRuns(cwd, this.projectsDir)
    const found = new Set(own.map(run => run.run))
    const elsewhere = runsNamedUnderOtherKeys(ledgerRuns.filter(run => !found.has(run)), key, this.projectsDir)
    const runs = [...own, ...elsewhere].sort(byStart)
    if (existsSync(path.join(this.projectsDir, key)) || elsewhere.length > 0)
      return { status: runs.length > 0 ? 'ok' : 'empty', runs, key, candidates: [] }
    const recorded = recordedElsewhere(cwd, key, this.projectsDir)
    if (recorded.length > 0)
      return { status: 'mismatch', runs: [], key, candidates: recorded }
    const lookalikes = lookalikeKeys(cwd, key, this.projectsDir)
    if (lookalikes.length > 0)
      return { status: 'unknown', runs: [], key, candidates: lookalikes }
    return { status: 'empty', runs: [], key, candidates: [] }
  }

  steps(run: string): RunDecomposition | null {
    const dirs = runDirsNamed(run, this.projectsDir)
    return dirs.length === 1 ? stepsOf(run, agentsIn(dirs[0])) : null
  }
}

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { billable, ClaudeCodeCostSource, costReport, knownSteps, projectKey, readStepCache, recordedSteps, STEP_CACHE_FILE, STEPS } from '../src/commands/cost/index.js'

const CLAUDE_CODE_ENV = { CLAUDECODE: '1' }

interface AgentFixture {
  label: string
  type: string
  phase?: string
  start: string
  end: string
  usages: Array<{ requestId: string, input: number, cacheWrite: number, cacheRead: number, output: number }>
}

function sessionLine(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`
}

function writeAgent(run: string, index: number, agent: AgentFixture): void {
  const lines = [
    sessionLine({ type: 'user', timestamp: agent.start, message: { role: 'user', content: 'the prompt' } }),
    ...agent.usages.map(usage => sessionLine({
      type: 'assistant',
      requestId: usage.requestId,
      timestamp: agent.end,
      message: { role: 'assistant', model: 'sonnet', usage: { input_tokens: usage.input, cache_creation_input_tokens: usage.cacheWrite, cache_read_input_tokens: usage.cacheRead, output_tokens: usage.output } },
    })),
  ]
  writeFileSync(path.join(run, `agent-${index}.jsonl`), lines.join(''))
  writeFileSync(path.join(run, `agent-${index}.meta.json`), JSON.stringify({ description: agent.label, agentType: agent.type, workflowPhase: agent.phase }))
}

const ESCALATED_RUN: AgentFixture[] = [
  { label: 'preflight', type: 'harness', phase: 'Preflight', start: '2026-09-30T10:00:00.000Z', end: '2026-09-30T10:00:40.000Z', usages: [{ requestId: 'req_p', input: 5, cacheWrite: 1000, cacheRead: 9000, output: 50 }] },
  { label: 'implement 1/3 @ low', type: 'implementer', phase: 'Implement', start: '2026-09-30T10:01:00.000Z', end: '2026-09-30T10:03:00.000Z', usages: [{ requestId: 'req_i1', input: 10, cacheWrite: 2000, cacheRead: 50000, output: 300 }] },
  { label: 'verify 1/3', type: 'harness', phase: 'Verify', start: '2026-09-30T10:03:10.000Z', end: '2026-09-30T10:03:40.000Z', usages: [{ requestId: 'req_v1', input: 3, cacheWrite: 700, cacheRead: 4000, output: 20 }] },
  { label: 'implement 2/3 @ medium', type: 'implementer', phase: 'Implement', start: '2026-09-30T10:04:00.000Z', end: '2026-09-30T10:09:00.000Z', usages: [{ requestId: 'req_i2', input: 20, cacheWrite: 4000, cacheRead: 90000, output: 900 }] },
  { label: 'verify 2/3', type: 'harness', phase: 'Verify', start: '2026-09-30T10:09:10.000Z', end: '2026-09-30T10:10:10.000Z', usages: [{ requestId: 'req_v2', input: 4, cacheWrite: 800, cacheRead: 5000, output: 30 }] },
]

function workspace(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-steps-repo-')))
}

function recordRun(projects: string, cwd: string, id: string, agents: AgentFixture[]): string {
  const run = path.join(projects, projectKey(cwd), 'session-1', 'subagents', 'workflows', id)
  mkdirSync(run, { recursive: true })
  agents.forEach((agent, index) => writeAgent(run, index + 1, agent))
  return run
}

function writeLedger(cwd: string, runs: string[]): void {
  mkdirSync(path.join(cwd, '.construct'), { recursive: true })
  writeFileSync(path.join(cwd, '.construct', 'runs.jsonl'), runs.map(run => JSON.stringify({
    run,
    at: '2026-09-30T10:11:00.000Z',
    task: 'a run of the ladder',
    effort: 'low',
    status: 'done',
    rung: 'medium',
    attempts: [{ rung: 1, effort: 'low', outcome: 'failed', reason: 'red' }, { rung: 2, effort: 'medium', outcome: 'passed', reason: '' }],
    agents: 5,
    tokens: 9000,
    toolUses: 20,
    seconds: 610,
  })).map(line => `${line}\n`).join(''))
}

function fixture(): { projects: string, cwd: string, run: string } {
  const projects = mkdtempSync(path.join(tmpdir(), 'construct-steps-projects-'))
  const cwd = workspace()
  const run = recordRun(projects, cwd, 'wf_steps', ESCALATED_RUN)
  writeLedger(cwd, ['wf_steps'])
  return { projects, cwd, run }
}

describe('construct cost: a run decomposed into its steps', () => {
  it('splits a run into one step per agent in start order, with role, attempt, effort, tokens and seconds', () => {
    const { projects } = fixture()
    expect(new ClaudeCodeCostSource(projects).steps('wf_steps')).toEqual({
      steps: [
        { step: 'preflight', role: 'harness', attempt: 1, effort: null, tokens: 1055, seconds: 40 },
        { step: 'implement', role: 'implementer', attempt: 1, effort: 'low', tokens: 2310, seconds: 120 },
        { step: 'verify', role: 'harness', attempt: 1, effort: null, tokens: 723, seconds: 30 },
        { step: 'implement', role: 'implementer', attempt: 2, effort: 'medium', tokens: 4920, seconds: 300 },
        { step: 'verify', role: 'harness', attempt: 2, effort: null, tokens: 834, seconds: 60 },
      ],
      unread: [],
    })
  })

  it('counts a request written twice under one requestId once', () => {
    const { projects, run } = fixture()
    const twice = readFileSync(path.join(run, 'agent-2.jsonl'), 'utf8').split('\n').filter(line => line.includes('req_i1'))[0]
    appendFileSync(path.join(run, 'agent-2.jsonl'), `${twice}\n`)
    expect(new ClaudeCodeCostSource(projects).steps('wf_steps')!.steps[1].tokens).toBe(2310)
  })

  it('finds the run under another project key, as the ledger join does', () => {
    const projects = mkdtempSync(path.join(tmpdir(), 'construct-steps-projects-'))
    recordRun(projects, '/Users/someone/projects/mc-worktree', 'wf_elsewhere', ESCALATED_RUN.slice(0, 1))
    expect(new ClaudeCodeCostSource(projects).steps('wf_elsewhere')?.steps).toHaveLength(1)
    expect(new ClaudeCodeCostSource(projects).steps('wf_absent')).toBeNull()
  })

  it('caches the steps of every ledger run construct cost reads, and the cache outlives the transcript', () => {
    const { projects, cwd, run } = fixture()
    costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    const cached = readStepCache(cwd).runs.get('wf_steps')
    expect(cached).toHaveLength(5)
    rmSync(run, { recursive: true })
    expect(new ClaudeCodeCostSource(projects).steps('wf_steps')).toBeNull()
    expect(recordedSteps(cwd, ['wf_steps'], new ClaudeCodeCostSource(projects)).runs.get('wf_steps')).toEqual(cached)
  })

  it('reads a cached run from the cache and never rewrites its line, even when the transcript changed since', () => {
    const { projects, cwd, run } = fixture()
    costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    const before = readFileSync(path.join(cwd, STEP_CACHE_FILE), 'utf8')
    writeAgent(run, 6, { label: 'verify 3/3', type: 'harness', phase: 'Verify', start: '2026-09-30T10:11:00.000Z', end: '2026-09-30T10:12:00.000Z', usages: [{ requestId: 'req_late', input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }] })
    costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(readFileSync(path.join(cwd, STEP_CACHE_FILE), 'utf8')).toBe(before)
    expect(recordedSteps(cwd, ['wf_steps'], new ClaudeCodeCostSource(projects)).runs.get('wf_steps')).toHaveLength(5)
  })

  it('appends after a missing final newline and leaves the last cached line intact', () => {
    const { projects, cwd } = fixture()
    const file = path.join(cwd, STEP_CACHE_FILE)
    mkdirSync(path.dirname(file), { recursive: true })
    const earlier = JSON.stringify({ v: 1, run: 'wf_earlier', steps: [{ step: 'implement', role: 'implementer', attempt: 1, effort: null, tokens: 7, seconds: 3 }] })
    writeFileSync(file, earlier)
    const cache = recordedSteps(cwd, ['wf_steps'], new ClaudeCodeCostSource(projects))
    const reread = readStepCache(cwd)
    expect(reread.malformed).toEqual([])
    expect(reread.runs.get('wf_earlier')).toEqual(JSON.parse(earlier).steps)
    expect(reread.runs.get('wf_steps')).toEqual(cache.runs.get('wf_steps'))
    expect(readFileSync(file, 'utf8').startsWith(`${earlier}\n`)).toBe(true)
  })

  it('reads the steps of a run the cache lacks without writing the cache', () => {
    const { projects, cwd } = fixture()
    expect(knownSteps(cwd, ['wf_steps'], new ClaudeCodeCostSource(projects)).runs.get('wf_steps')).toHaveLength(5)
    expect(existsSync(path.join(cwd, STEP_CACHE_FILE))).toBe(false)
  })

  it('stores only counts, times and the role of each step — no message content', () => {
    const { projects, cwd } = fixture()
    costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    const text = readFileSync(path.join(cwd, STEP_CACHE_FILE), 'utf8')
    expect(text).not.toContain('the prompt')
    const line = JSON.parse(text.trim()) as { steps: Array<Record<string, unknown>> }
    expect(Object.keys(line).sort()).toEqual(['run', 'steps', 'v'])
    for (const step of line.steps)
      expect(Object.keys(step).sort()).toEqual(['attempt', 'effort', 'role', 'seconds', 'step', 'tokens'])
  })

  it('leaves the run total construct cost reports as it was', () => {
    const { projects, cwd } = fixture()
    const report = costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(billable(report.runs![0].total)).toBe(167_842)
  })
})

describe('construct cost: a run whose directory is not exactly one', () => {
  it('has no decomposition and caches nothing when no directory holds the run', () => {
    const { projects, cwd } = fixture()
    expect(new ClaudeCodeCostSource(projects).steps('wf_absent')).toBeNull()
    expect(recordedSteps(cwd, ['wf_absent'], new ClaudeCodeCostSource(projects)).runs.has('wf_absent')).toBe(false)
    expect(existsSync(path.join(cwd, STEP_CACHE_FILE))).toBe(false)
  })

  it('has no decomposition and caches nothing when two project keys each hold a directory of the run', () => {
    const { projects, cwd } = fixture()
    recordRun(projects, '/Users/someone/projects/mc-worktree', 'wf_steps', ESCALATED_RUN.slice(0, 1))
    expect(new ClaudeCodeCostSource(projects).steps('wf_steps')).toBeNull()
    expect(recordedSteps(cwd, ['wf_steps'], new ClaudeCodeCostSource(projects)).runs.has('wf_steps')).toBe(false)
    expect(existsSync(path.join(cwd, STEP_CACHE_FILE))).toBe(false)
  })
})

describe('construct cost: an agent whose step is not one of STEPS', () => {
  const WITHOUT_PHASE: AgentFixture = { label: 'a stray agent', type: 'implementer', start: '2026-09-30T10:10:20.000Z', end: '2026-09-30T10:10:30.000Z', usages: [{ requestId: 'req_s', input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }] }
  const OFF_LIST_PHASE: AgentFixture = { ...WITHOUT_PHASE, label: 'a review', type: 'review', phase: 'Review' }

  function runWith(agent: AgentFixture): { projects: string, cwd: string } {
    const projects = mkdtempSync(path.join(tmpdir(), 'construct-steps-projects-'))
    const cwd = workspace()
    recordRun(projects, cwd, 'wf_stray', [...ESCALATED_RUN, agent])
    writeLedger(cwd, ['wf_stray'])
    return { projects, cwd }
  }

  function cachedStepNames(cwd: string): string[] {
    const file = path.join(cwd, STEP_CACHE_FILE)
    if (!existsSync(file))
      return []
    return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').flatMap(line => (JSON.parse(line) as { steps: Array<{ step: string }> }).steps.map(step => step.step))
  }

  it('writes no step outside STEPS and no line for the run when an agent has no workflow phase', () => {
    const { projects, cwd } = runWith(WITHOUT_PHASE)
    costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(cachedStepNames(cwd).filter(step => !(STEPS as readonly string[]).includes(step))).toEqual([])
    expect(readStepCache(cwd).runs.has('wf_stray')).toBe(false)
  })

  it('names the agent without a phase as unread, with its run and the reason', () => {
    const { projects, cwd } = runWith(WITHOUT_PHASE)
    const cache = recordedSteps(cwd, ['wf_stray'], new ClaudeCodeCostSource(projects))
    expect(cache.runs.has('wf_stray')).toBe(false)
    expect(cache.unread).toEqual([{ run: 'wf_stray', agent: 'a stray agent', reason: 'no workflow phase' }])
  })

  it('takes no step from the agent type, even when the type is spelled like a step', () => {
    const { projects, cwd } = runWith({ ...WITHOUT_PHASE, label: 'a verify agent', type: 'verify' })
    const cache = recordedSteps(cwd, ['wf_stray'], new ClaudeCodeCostSource(projects))
    expect(cache.unread).toEqual([{ run: 'wf_stray', agent: 'a verify agent', reason: 'no workflow phase' }])
    expect(cache.runs.has('wf_stray')).toBe(false)
  })

  it('names an agent whose phase is not one of STEPS as unread and caches nothing for its run', () => {
    const { projects, cwd } = runWith(OFF_LIST_PHASE)
    const cache = recordedSteps(cwd, ['wf_stray'], new ClaudeCodeCostSource(projects))
    expect(cache.unread).toEqual([{ run: 'wf_stray', agent: 'a review', reason: 'phase review is not a step' }])
    expect(existsSync(path.join(cwd, STEP_CACHE_FILE))).toBe(false)
  })
})

describe('docs/cli.md: Steps of a run', () => {
  it('names every member of STEPS', () => {
    const doc = readFileSync(path.join(import.meta.dirname, '..', 'docs', 'cli.md'), 'utf8')
    const section = doc.split('### Steps of a run')[1].split(/^#{1,3} /m)[0]
    for (const step of STEPS)
      expect(section).toContain(`\`${step}\``)
  })
})

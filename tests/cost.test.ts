import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { billable, COST_EXIT, costJson, costReport, printCost, projectKey, weighted } from '../src/commands/cost/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

function line(model: string, usage: Record<string, number>): string {
  return `${JSON.stringify({ message: { role: 'assistant', model, usage } })}\n`
}

function projectsRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-cost-'))
}

function workspace(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-repo-')))
}

function recordRun(projects: string, cwd: string): string {
  const run = path.join(projects, projectKey(cwd), 'session-1', 'subagents', 'workflows', 'wf_abc')
  mkdirSync(run, { recursive: true })
  writeFileSync(path.join(run, 'agent-1.jsonl'), `${line('sonnet', { input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 50 })}not json\n${line('sonnet', { input_tokens: 10, output_tokens: 5 })}`)
  writeFileSync(path.join(run, 'agent-1.meta.json'), JSON.stringify({ description: 'implement 1/4 @ low', agentType: 'implementer' }))
  writeFileSync(path.join(run, 'agent-2.jsonl'), line('sonnet', { input_tokens: 20, output_tokens: 2 }))
  return run
}

function printed(report: Parameters<typeof printCost>[1]): { exit: number, text: string } {
  const lines: string[] = []
  const exit = printCost(createUi(resolveTheme({ plain: true }), text => lines.push(text)), report, false)
  return { exit, text: lines.join('') }
}

const CLAUDE_CODE_ENV = { CLAUDECODE: '1' }
const CURSOR_ENV = { CURSOR_AGENT: '1' }

describe('construct cost', () => {
  it('sums assistant usage per agent and per run from Claude Code session data', () => {
    const projects = projectsRoot()
    const cwd = '/Users/someone/projects/demo'
    recordRun(projects, cwd)

    const report = costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(report.status).toBe('ok')
    expect(report.runs).toHaveLength(1)
    const [only] = report.runs!
    expect(only.run).toBe('wf_abc')
    expect(only.agents.map(agent => [agent.type, agent.label, agent.usage.calls])).toEqual([['implementer', 'implement 1/4 @ low', 2], ['?', 'agent-2.jsonl', 1]])
    expect(only.total).toMatchObject({ calls: 3, input: 130, cacheRead: 400, output: 57, models: ['sonnet'] })
    expect(billable(only.total)).toBe(587)
    expect(weighted(only.total)).toBe(455)
    expect(printed(report).exit).toBe(0)
  })

  it('reports a supported runtime with no recorded runs as a readable absence', () => {
    const projects = projectsRoot()
    const cwd = workspace()
    mkdirSync(path.join(projects, projectKey(cwd), 'session-1'), { recursive: true })

    const report = costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(report.status).toBe('empty')
    expect(costJson(report, false)).toMatchObject({ status: 'empty', runtime: 'claude-code' })
    const { exit, text } = printed(report)
    expect(exit).toBe(0)
    expect(text).toContain('No /implement runs recorded here yet.')
  })

  it('reports a directory the runtime has never seen as a readable absence too', () => {
    const report = costReport(workspace(), { projectsDir: projectsRoot(), env: CLAUDE_CODE_ENV })
    expect(report.status).toBe('empty')
    expect(printed(report).exit).toBe(0)
  })

  it('reports a runtime that does not expose per-run usage as unsupported, not as absence', () => {
    const report = costReport(workspace(), { projectsDir: projectsRoot(), env: CURSOR_ENV })
    expect(report).toEqual({ status: 'unsupported', runtime: 'cursor' })
    expect(costJson(report, false)).toEqual({ status: 'unsupported', runtime: 'cursor' })
    const { exit, text } = printed(report)
    expect(exit).toBe(COST_EXIT.unsupported)
    expect(exit).not.toBe(COST_EXIT.ok)
    expect(exit).not.toBe(COST_EXIT.empty)
    expect(text).toContain('does not expose per-run token usage')
    expect(text).not.toContain('No /implement runs')
  })

  it('reports a runtime whose usage store is absent as unsupported', () => {
    const projects = path.join(projectsRoot(), 'never-written')
    const report = costReport(workspace(), { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(report).toEqual({ status: 'unsupported', runtime: 'claude-code' })
  })

  it('names the key it looked up when the runs were recorded under the path the directory resolves to', () => {
    const projects = projectsRoot()
    const real = workspace()
    recordRun(projects, real)
    const link = path.join(mkdtempSync(path.join(tmpdir(), 'construct-link-')), 'demo')
    symlinkSync(real, link)

    const report = costReport(link, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(report.status).toBe('mismatch')
    expect(report.key).toBe(projectKey(link))
    expect(report.candidates).toContain(projectKey(real))
    const { exit, text } = printed(report)
    expect(exit).toBe(COST_EXIT.mismatch)
    expect(text).toContain(projectKey(link))
    expect(text).toContain('recorded under another path')
  })

  it('names the key it looked up when a git worktree points at a repository recorded elsewhere', () => {
    const projects = projectsRoot()
    const main = workspace()
    recordRun(projects, main)
    const tree = workspace()
    writeFileSync(path.join(tree, '.git'), `gitdir: ${main}/.git/worktrees/feature\n`)

    const report = costReport(tree, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(report.status).toBe('mismatch')
    expect(report.key).toBe(projectKey(tree))
    expect(report.candidates).toEqual([projectKey(main)])
  })

  it('reports unknown rather than guessing when the sibling evidence does not settle it', () => {
    const projects = projectsRoot()
    const cwd = path.join(workspace(), 'demo')
    mkdirSync(cwd)
    mkdirSync(path.join(projects, projectKey('/elsewhere/checkouts/demo')), { recursive: true })

    const report = costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(report.status).toBe('unknown')
    expect(report.key).toBe(projectKey(cwd))
    expect(report.candidates).toEqual([projectKey('/elsewhere/checkouts/demo')])
    const { exit, text } = printed(report)
    expect(exit).toBe(COST_EXIT.unknown)
    expect(text).toContain('not conclusive')
  })
})

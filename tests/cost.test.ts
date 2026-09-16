import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { billable, collectWorkflowRuns, projectKey } from '../src/commands/cost.js'

function line(model: string, usage: Record<string, number>): string {
  return `${JSON.stringify({ message: { role: 'assistant', model, usage } })}\n`
}

describe('construct cost', () => {
  it('sums assistant usage per agent and per run from Claude Code session data', () => {
    const projects = mkdtempSync(path.join(tmpdir(), 'construct-cost-'))
    const cwd = '/Users/someone/projects/demo'
    const run = path.join(projects, projectKey(cwd), 'session-1', 'subagents', 'workflows', 'wf_abc')
    mkdirSync(run, { recursive: true })
    writeFileSync(path.join(run, 'agent-1.jsonl'), `${line('sonnet', { input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 50 })}not json\n${line('sonnet', { input_tokens: 10, output_tokens: 5 })}`)
    writeFileSync(path.join(run, 'agent-1.meta.json'), JSON.stringify({ description: 'implement 1/4 @ low', agentType: 'implementer' }))
    writeFileSync(path.join(run, 'agent-2.jsonl'), line('sonnet', { input_tokens: 20, output_tokens: 2 }))

    const runs = collectWorkflowRuns(cwd, projects)
    expect(runs).toHaveLength(1)
    const [only] = runs!
    expect(only.run).toBe('wf_abc')
    expect(only.agents.map(agent => [agent.type, agent.label, agent.usage.calls])).toEqual([['implementer', 'implement 1/4 @ low', 2], ['?', 'agent-2.jsonl', 1]])
    expect(only.total).toMatchObject({ calls: 3, input: 130, cacheRead: 400, output: 57, models: ['sonnet'] })
    expect(billable(only.total)).toBe(587)
  })

  it('reports no data for a directory Claude Code has never seen', () => {
    expect(collectWorkflowRuns('/nowhere', mkdtempSync(path.join(tmpdir(), 'construct-cost-')))).toBeNull()
  })
})

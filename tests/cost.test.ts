import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { billable, COST_EXIT, costJson, costReport, printCost, projectKey, readLedger, weighted } from '../src/commands/cost/index.js'
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

function ledgerEntry(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: 'wf_abc',
    at: '2026-09-17T10:00:00.000Z',
    task: 'give the run ledger a reader',
    effort: 'low',
    status: 'done',
    rung: 'low',
    attempts: [{ rung: 1, effort: 'low', outcome: 'passed', reason: '' }],
    agents: 2,
    tokens: 1000,
    toolUses: 9,
    seconds: 120,
    ...fields,
  }
}

function writeLedger(cwd: string, lines: string[]): void {
  mkdirSync(path.join(cwd, '.construct'), { recursive: true })
  writeFileSync(path.join(cwd, '.construct', 'runs.jsonl'), `${lines.join('\n')}\n`)
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

describe('the run ledger', () => {
  it('reads the declared fields and reports a line it cannot read with its line number', () => {
    const cwd = workspace()
    writeLedger(cwd, [JSON.stringify(ledgerEntry()), 'not json', JSON.stringify({ run: 'wf_two', at: '2026-09-17T11:00:00.000Z' })])

    const reading = readLedger(cwd)
    expect(reading.entries).toEqual([{
      run: 'wf_abc',
      at: '2026-09-17T10:00:00.000Z',
      task: 'give the run ledger a reader',
      effort: 'low',
      status: 'done',
      rung: 'low',
      attempts: [{ rung: 1, effort: 'low', outcome: 'passed', reason: '' }],
      agents: 2,
      tokens: 1000,
      toolUses: 9,
      seconds: 120,
    }])
    expect(reading.malformed).toEqual([
      { line: 2, reason: 'not JSON' },
      { line: 3, reason: expect.stringContaining('missing or invalid: task, effort, status, rung') },
    ])
  })

  it('reads a line whose status and outcome this version has never heard of, because a newer CLI writes the ledger an older one reads', () => {
    const cwd = workspace()
    const fromTheFuture = ledgerEntry({
      run: 'wf_future',
      status: 'a status this version does not know',
      attempts: [{ rung: 1, effort: 'unheard-of', outcome: 'an outcome this version does not know', reason: '' }],
    })
    writeLedger(cwd, [JSON.stringify(ledgerEntry()), JSON.stringify(fromTheFuture)])

    const reading = readLedger(cwd)
    expect(reading.malformed).toEqual([])
    expect(reading.entries.map(entry => entry.status)).toEqual(['done', 'a status this version does not know'])
    expect(reading.entries[1].attempts[0].outcome).toBe('an outcome this version does not know')
  })

  it('reads a run whose design step did not complete and leaves the lines around it readable', () => {
    const cwd = workspace()
    const degraded = ledgerEntry({
      run: 'wf_design',
      effort: 'medium',
      status: 'design incomplete',
      rung: 'xhigh',
      attempts: [{ rung: 1, effort: 'xhigh', outcome: 'design schema invalid', reason: 'SPEC: decision: missing' }],
    })
    writeLedger(cwd, [JSON.stringify(ledgerEntry()), JSON.stringify(degraded)])

    const reading = readLedger(cwd)
    expect(reading.malformed).toEqual([])
    expect(reading.entries.map(entry => entry.status)).toEqual(['done', 'design incomplete'])
    expect(reading.entries[1].attempts).toEqual(degraded.attempts)
  })

  it('names the attempt field that is missing, not just the attempts array', () => {
    const cwd = workspace()
    const entry = {
      run: 'wf_a',
      at: '2026-09-17T00:00:00.000Z',
      task: 't',
      effort: 'low',
      status: 'done',
      rung: 'low',
      attempts: [{ rung: 1, effort: 'low', outcome: 'passed' }],
      agents: 1,
      tokens: 10,
      toolUses: 1,
      seconds: 1,
    }
    mkdirSync(path.join(cwd, '.construct'), { recursive: true })
    writeFileSync(path.join(cwd, '.construct/runs.jsonl'), `${JSON.stringify(entry)}\n`)

    expect(readLedger(cwd).malformed).toEqual([{ line: 1, reason: 'missing or invalid: attempts[0].reason' }])
  })

  it('never reads a token count of unknown as zero', () => {
    const cwd = workspace()
    const projects = projectsRoot()
    mkdirSync(path.join(projects, projectKey(cwd)), { recursive: true })
    writeLedger(cwd, [JSON.stringify(ledgerEntry({ tokens: 'unknown' })), JSON.stringify(ledgerEntry({ run: 'wf_two', tokens: 5000 }))])

    const report = costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(report.ledger).toMatchObject({ runs: 2, agents: 4, failures: 0, tokens: 'unknown' })
    expect(printed(report).text).toContain('unknown tokens')
  })

  it('joins on the run identifier and reports drift in both directions without changing the status', () => {
    const projects = projectsRoot()
    const cwd = workspace()
    recordRun(projects, cwd)
    writeLedger(cwd, [JSON.stringify(ledgerEntry({ run: 'wf_gone', status: 'failed' }))])

    const report = costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(report.status).toBe('ok')
    expect(report.reconciliation).toEqual({ entriesWithoutSession: ['wf_gone'], sessionsWithoutEntry: ['wf_abc'], unjoinable: 0 })
    expect(costJson(report, false)).toMatchObject({ status: 'ok', reconciliation: { entriesWithoutSession: ['wf_gone'], sessionsWithoutEntry: ['wf_abc'], unjoinable: 0 } })
    const { exit, text } = printed(report)
    expect(exit).toBe(COST_EXIT.ok)
    expect(text).toContain('1 entries with no session, 1 sessions with no entry, 0 entries with no run id')
    expect(text).toContain('wf_gone')
  })

  it('counts an entry without a run identifier as unjoinable rather than pairing it with a session', () => {
    const projects = projectsRoot()
    const cwd = workspace()
    recordRun(projects, cwd)
    const { run: _run, ...withoutRun } = ledgerEntry()
    writeLedger(cwd, [JSON.stringify(withoutRun)])

    const report = costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV })
    expect(report.reconciliation).toEqual({ entriesWithoutSession: [], sessionsWithoutEntry: ['wf_abc'], unjoinable: 1 })
  })

  it('shows the ledger counts with every token figure unknown on a runtime that exposes no usage', () => {
    const cwd = workspace()
    writeLedger(cwd, [JSON.stringify(ledgerEntry()), JSON.stringify(ledgerEntry({ run: 'wf_two', status: 'failed' }))])

    const report = costReport(cwd, { projectsDir: projectsRoot(), env: CURSOR_ENV })
    expect(report.status).toBe('unsupported')
    expect(report.reconciliation).toBeUndefined()
    expect(report.ledger).toEqual({ runs: 2, agents: 4, failures: 1, tokens: 'unknown', malformed: [] })
    const { exit, text } = printed(report)
    expect(exit).toBe(COST_EXIT.unsupported)
    expect(text).toContain('2 runs, 4 agents, 1 unfinished, unknown tokens')
    expect(text).not.toContain('0 tokens')
  })

  it('reports an unreadable line even when the runtime has nothing to reconcile it against', () => {
    const cwd = workspace()
    writeLedger(cwd, ['{ broken'])

    const report = costReport(cwd, { projectsDir: projectsRoot(), env: CURSOR_ENV })
    expect(report.ledger?.malformed).toEqual([{ line: 1, reason: 'not JSON' }])
    expect(printed(report).text).toContain('line 1: not JSON')
  })
})

describe('one response is one response, however many blocks the journal splits it into', () => {
  function block(requestId: string, usage: Record<string, number>): string {
    return `${JSON.stringify({ requestId, message: { role: 'assistant', model: 'sonnet', usage } })}\n`
  }

  it('counts a response once when the journal repeats its usage on every content block', () => {
    const projects = projectsRoot()
    const cwd = '/Users/someone/projects/blocks'
    const run = path.join(projects, projectKey(cwd), 'session-1', 'subagents', 'workflows', 'wf_blocks')
    mkdirSync(run, { recursive: true })
    const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50000, output_tokens: 300 }
    writeFileSync(path.join(run, 'agent-1.jsonl'), block('req_1', usage) + block('req_1', usage) + block('req_1', usage))
    writeFileSync(path.join(run, 'agent-1.meta.json'), JSON.stringify({ description: 'design', agentType: 'architect' }))

    const [recorded] = costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV }).runs!
    expect(recorded.total.calls).toBe(1)
    expect(billable(recorded.total)).toBe(51302)
  })

  it('counts separate responses separately, so deduplication never hides a real call', () => {
    const projects = projectsRoot()
    const cwd = '/Users/someone/projects/two'
    const run = path.join(projects, projectKey(cwd), 'session-1', 'subagents', 'workflows', 'wf_two')
    mkdirSync(run, { recursive: true })
    const usage = { input_tokens: 1, output_tokens: 10 }
    writeFileSync(path.join(run, 'agent-1.jsonl'), block('req_1', usage) + block('req_1', usage) + block('req_2', usage))
    writeFileSync(path.join(run, 'agent-1.meta.json'), JSON.stringify({ description: 'design', agentType: 'architect' }))

    const [recorded] = costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV }).runs!
    expect(recorded.total.calls).toBe(2)
    expect(billable(recorded.total)).toBe(22)
  })

  it('still counts a line the runtime recorded without a request identifier', () => {
    const projects = projectsRoot()
    const cwd = '/Users/someone/projects/plain'
    const run = path.join(projects, projectKey(cwd), 'session-1', 'subagents', 'workflows', 'wf_plain')
    mkdirSync(run, { recursive: true })
    writeFileSync(path.join(run, 'agent-1.jsonl'), line('sonnet', { input_tokens: 5, output_tokens: 5 }) + line('sonnet', { input_tokens: 5, output_tokens: 5 }))
    writeFileSync(path.join(run, 'agent-1.meta.json'), JSON.stringify({ description: 'design', agentType: 'architect' }))

    const [recorded] = costReport(cwd, { projectsDir: projects, env: CLAUDE_CODE_ENV }).runs!
    expect(recorded.total.calls).toBe(2)
    expect(billable(recorded.total)).toBe(20)
  })
})

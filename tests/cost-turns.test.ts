import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectWorkflowRuns, costJson, costReport, printCost, projectKey, readTurnJournal, TURN_JOURNAL_FILE } from '../src/commands/cost/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const HOOK = path.resolve(import.meta.dirname, '../.claude/hooks/turn-journal.mjs')
const SAMPLE = path.resolve(import.meta.dirname, 'fixtures/transcripts/claude-code-2.1.284.jsonl')

function usage(calls: number, input: number, cacheWrite: number, cacheRead: number, output: number): object {
  return { calls, input, cacheWrite, cacheRead, output, models: ['m-1'] }
}

function line(fields: object): string {
  return JSON.stringify({ v: 1, ...fields })
}

function world(lines: string[] | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-turns-cost-'))
  if (lines != null) {
    mkdirSync(path.join(dir, '.construct'))
    writeFileSync(path.join(dir, TURN_JOURNAL_FILE), `${lines.join('\n')}\n`)
  }
  return dir
}

function text(report: ReturnType<typeof costReport>): string {
  const out: string[] = []
  printCost(createUi(resolveTheme({ plain: true }), chunk => out.push(chunk)), report, false)
  return out.join('')
}

describe('construct cost reads the turn journal', () => {
  it('an absent turn journal reads as not recorded', () => {
    for (const env of [{ CLAUDECODE: '1' }, { CURSOR_AGENT: '1' }]) {
      const report = costReport(world(null), { projectsDir: mkdtempSync(path.join(tmpdir(), 'construct-turns-projects-')), env })
      expect(costJson(report, false).turns).toEqual({ status: 'not recorded' })
      expect(text(report)).toContain('not recorded')
      expect(text(report)).toContain(TURN_JOURNAL_FILE)
      expect(text(report)).not.toMatch(/\b0 turns\b/)
    }
  })

  it('a recorded turn journal reads as turns, sessions, usage, unmeasured turns, gaps and malformed lines', () => {
    const dir = world([
      line({ kind: 'turn', session: 'sess-a', prompt: 'p1', end: 'stop', from: 0, to: 100, usage: usage(1, 10, 0, 100, 5) }),
      line({ kind: 'late', session: 'sess-a', prompt: 'p1', from: 100, to: 150, usage: usage(1, 1, 0, 0, 1) }),
      line({ kind: 'subagent', session: 'sess-a', prompt: 'p1', agent: 'a1', agentType: 'Explore', from: 0, to: 10, usage: usage(2, 20, 10, 0, 4) }),
      line({ kind: 'turn', session: 'sess-a', prompt: 'p2', end: 'stop', from: 200, to: 300, usage: usage(1, 2, 0, 0, 2) }),
      line({ kind: 'turn', session: 'sess-b', prompt: 'p3', end: 'stop', from: null, to: 50, usage: 'unknown', reset: 'shrunk' }),
      line({ kind: 'turn', session: 'sess-b', prompt: 'p4', end: 'stop', from: 50, to: 80, usage: usage(1, 3, 0, 0, 3) }),
      'not json',
      JSON.stringify({ v: 2, kind: 'turn', session: 'sess-a' }),
      line({ kind: 'session-end', session: 'sess-a', reason: 'other' }),
    ])
    const summary = readTurnJournal(dir)
    expect(summary).toMatchObject({ status: 'recorded', turns: 4, sessions: 2, main: usage(4, 16, 0, 100, 11), subagents: usage(2, 20, 10, 0, 4), unmeasured: 1, gaps: 1 })
    expect(summary.status === 'recorded' && summary.malformed.map(entry => entry.line)).toEqual([7, 8])
    const report = costReport(dir, { projectsDir: mkdtempSync(path.join(tmpdir(), 'construct-turns-projects-')), env: { CLAUDECODE: '1' } })
    expect(text(report)).toContain('4 turns')
    expect(text(report)).toContain('2 sessions')
  })

  it('the hook and cost count the recorded sample alike', async () => {
    const hook = await import(HOOK) as { measure: (text: string) => { usage: unknown, toolCalls: unknown, unreadable: number }, TURN_JOURNAL_FILE: string }
    expect(hook.TURN_JOURNAL_FILE).toBe(TURN_JOURNAL_FILE)
    const measured = hook.measure(readFileSync(SAMPLE, 'utf8'))
    expect(measured.usage).toEqual({ calls: 10, input: 20, cacheWrite: 70660, cacheRead: 820670, output: 3840, models: ['claude-opus-5-5'] })
    expect(measured.toolCalls).toEqual({ Bash: 6, Read: 2, Edit: 4 })
    expect(measured.unreadable).toBe(0)
    const cwd = mkdtempSync(path.join(tmpdir(), 'construct-turns-sample-'))
    const projects = mkdtempSync(path.join(tmpdir(), 'construct-turns-projects-'))
    const run = path.join(projects, projectKey(cwd), 'session-1', 'subagents', 'workflows', 'wf_sample')
    mkdirSync(run, { recursive: true })
    copyFileSync(SAMPLE, path.join(run, 'agent-1.jsonl'))
    expect(collectWorkflowRuns(cwd, projects).map(entry => entry.total)).toEqual([measured.usage])
  })
})

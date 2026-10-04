import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cheapForecast, cheapForecastOf, cheapRows, ClaudeCodeCostSource, costReport, printCost, projectKey, readCheapTasks, sessionTokens } from '../src/commands/cost/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

function root(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-cheap-')))
}

function usageLine(tokens: number, requestId: string): string {
  return JSON.stringify({ requestId, message: { role: 'assistant', usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } })
}

function writeSession(projects: string, worktree: string, session: string, lines: string[]): void {
  const file = path.join(projects, projectKey(worktree), `${session}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
}

function taskLine(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'task',
    task: '1',
    card: { kind: 'implement', size: 'S', contour: 'cheap' },
    worktree: '/work/mc-1',
    session: 's1',
    continuations: [],
    started: '2026-10-01T00:00:00.000Z',
    ended: '2026-10-01T00:04:00.000Z',
    exit: 0,
    report: true,
    ...fields,
  }
}

function writeShift(shiftRoot: string, name: string, lines: unknown[]): void {
  mkdirSync(path.join(shiftRoot, name), { recursive: true })
  writeFileSync(path.join(shiftRoot, name, 'shift.jsonl'), `${lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`)
}

describe('the cheap forecast', () => {
  it('reads every finished cheap task of every shift under the root, classed by kind and size, with its sessions and wall minutes', () => {
    const shifts = root()
    writeShift(shifts, 'a', [{ event: 'start' }, taskLine({ continuations: ['s2'] }), 'not json'])
    writeShift(shifts, 'b', [
      taskLine({ task: '2', card: { kind: 'probe', size: 'M', contour: 'cheap' } }),
      taskLine({ task: 'ladder', card: { kind: 'implement', size: 'S', contour: 'ladder' } }),
      taskLine({ task: 'failed', exit: 1 }),
      taskLine({ task: 'silent', report: false }),
      taskLine({ task: 'cardless', card: undefined }),
      taskLine({ task: 'refused', worktree: null }),
    ])
    expect(readCheapTasks(shifts)).toEqual([
      { task: '1', taskClass: 'implement/S', worktree: '/work/mc-1', sessions: ['s1', 's2'], minutes: 4 },
      { task: '2', taskClass: 'probe/M', worktree: '/work/mc-1', sessions: ['s1'], minutes: 4 },
    ])
    expect(readCheapTasks(path.join(shifts, 'absent'))).toEqual([])
  })

  it('counts a session\'s tokens once per request, across the session file and every subagent file under it', () => {
    const projects = root()
    writeSession(projects, '/work/mc-1', 's1', [usageLine(100, 'r1'), usageLine(100, 'r1'), usageLine(50, 'r2'), 'not json'])
    const subagent = path.join(projects, projectKey('/work/mc-1'), 's1', 'subagents', 'workflows', 'wf_1', 'agent-1.jsonl')
    mkdirSync(path.dirname(subagent), { recursive: true })
    writeFileSync(subagent, `${usageLine(7, 'r9')}\n`)
    expect(sessionTokens(projects, '/work/mc-1', 's1')).toBe(157)
    expect(sessionTokens(projects, '/work/mc-1', 'absent')).toBeNull()
  })

  it('counts one session file in the unit the ladder forecasts in: input, cache writes and output, cache reads left out', () => {
    const projects = root()
    const lines = [
      JSON.stringify({ requestId: 'r1', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'assistant', usage: { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 90_000, output_tokens: 40 } } }),
      JSON.stringify({ requestId: 'r1', timestamp: '2026-10-01T00:00:01.000Z', message: { role: 'assistant', usage: { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 90_000, output_tokens: 40 } } }),
      JSON.stringify({ requestId: 'r2', timestamp: '2026-10-01T00:01:00.000Z', message: { role: 'assistant', usage: { input_tokens: 7, cache_creation_input_tokens: 1_200, cache_read_input_tokens: 95_000, output_tokens: 300 } } }),
    ]
    writeSession(projects, '/work/mc-1', 'cheap', lines)
    const runDir = path.join(projects, projectKey('/work/mc-1'), 'ladder', 'subagents', 'workflows', 'wf_1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(path.join(runDir, 'agent-a.jsonl'), `${lines.join('\n')}\n`)
    writeFileSync(path.join(runDir, 'agent-a.meta.json'), JSON.stringify({ description: 'implement @ low', agentType: 'implementer', workflowPhase: 'Implement' }))
    const ladderTokens = new ClaudeCodeCostSource(projects).steps('wf_1')?.steps.map(step => step.tokens)
    expect(ladderTokens).toEqual([2_050])
    expect(sessionTokens(projects, '/work/mc-1', 'cheap')).toBe(2_050)
  })

  it('sums a task\'s sessions and leaves out a task whose session file is gone', () => {
    const projects = root()
    writeSession(projects, '/work/mc-1', 's1', [usageLine(100, 'r1')])
    writeSession(projects, '/work/mc-1', 's2', [usageLine(20, 'r1')])
    const tasks = [
      { task: '1', taskClass: 'implement/S', worktree: '/work/mc-1', sessions: ['s1', 's2'], minutes: 4 },
      { task: '2', taskClass: 'implement/S', worktree: '/work/mc-1', sessions: ['s1', 'gone'], minutes: 4 },
      { task: '3', taskClass: 'probe/S', worktree: '/work/mc-1', sessions: ['s1'], minutes: 4 },
    ]
    expect(cheapRows(tasks, 'implement/S', projects)).toEqual([{ task: '1', tokens: 120, minutes: 4 }])
  })

  it('forecasts the median tokens and minutes from five rows of the class, and none with n below five', () => {
    const rows = [1, 2, 3, 4, 50].map(index => ({ task: String(index), tokens: index * 1000, minutes: index }))
    expect(cheapForecast(rows, 'implement/S')).toEqual({ kind: 'forecast', taskClass: 'implement/S', n: 5, tokens: 3000, minutes: 3 })
    expect(cheapForecast(rows.slice(0, 4), 'implement/S')).toEqual({ kind: 'none', taskClass: 'implement/S', n: 4 })
  })

  it('reads the shifts and the sessions together into one forecast', () => {
    const shifts = root()
    const projects = root()
    writeShift(shifts, 'a', [1, 2, 3, 4, 5, 6].map((index) => {
      writeSession(projects, `/work/mc-${index}`, `s${index}`, [usageLine(index * 1000, 'r1')])
      return taskLine({ task: String(index), worktree: `/work/mc-${index}`, session: `s${index}` })
    }))
    expect(cheapForecastOf(shifts, 'implement/S', projects)).toEqual({ kind: 'forecast', taskClass: 'implement/S', n: 6, tokens: 3500, minutes: 4 })
    expect(cheapForecastOf(shifts, 'probe/S', projects)).toEqual({ kind: 'none', taskClass: 'probe/S', n: 0 })
  })
})

function cheapWorld(tokensPerTask: number[]): { shifts: string, projects: string } {
  const shifts = root()
  const projects = root()
  writeShift(shifts, 'a', [...tokensPerTask.map((tokens, index) => {
    writeSession(projects, `/work/mc-${index}`, `s${index}`, [usageLine(tokens, 'r1')])
    return taskLine({ task: String(index), worktree: `/work/mc-${index}`, session: `s${index}` })
  }), taskLine({ task: 'gone', worktree: '/work/mc-gone', session: 'gone' })])
  return { shifts, projects }
}

function costLines(shifts: string, projects: string): string[] {
  const report = costReport(root(), { projectsDir: projects, shiftRoot: shifts, env: { CLAUDECODE: '1' } })
  const out: string[] = []
  printCost(createUi(resolveTheme({ plain: true }), text => out.push(text)), report, false)
  return out.join('').split('\n')
}

function cheapBlock(lines: string[]): string[] {
  const at = lines.findIndex(line => line.startsWith('---- cost · cheap'))
  return at === -1 ? [] : lines.slice(at, at + 5)
}

describe('construct cost prints the cheap forecast as a signal block', () => {
  it('prints the median of five finished tasks of the class in the unit named in words, and counts the task whose session is gone as read but not counted', () => {
    const { shifts, projects } = cheapWorld([1000, 2000, 3000, 4000, 5000])
    const block = cheapBlock(costLines(shifts, projects))
    expect(block[0]).toMatch(/^---- cost · cheap implement\/S -+$/)
    expect(block.slice(1)).toEqual([
      `CONTRACT | finished cheap tasks of class implement/S in the shift journals under ${shifts}`,
      'EXPECT   | tokens ≈ 3,000 (input, cache writes and output; cache reads left out), minutes ≈ 4 — class implement/S, n=5, median',
      `ACTION   | read 6 finished tasks of the class; 5 with every session in ${projects}`,
      'RESULT   | forecast for the next task of this class',
    ])
  })

  it('moves the forecast when one task of the sample spends differently', () => {
    const { shifts, projects } = cheapWorld([1000, 2000, 9000, 4000, 5000])
    expect(cheapBlock(costLines(shifts, projects))[2]).toBe('EXPECT   | tokens ≈ 4,000 (input, cache writes and output; cache reads left out), minutes ≈ 4 — class implement/S, n=5, median')
  })

  it('says none with n and the class below five tasks with readable sessions', () => {
    const { shifts, projects } = cheapWorld([1000, 2000, 3000, 4000])
    expect(cheapBlock(costLines(shifts, projects)).slice(2)).toEqual([
      'EXPECT   | none: 4 finished cheap tasks of implement/S with every session readable, fewer than 5, so no forecast',
      `ACTION   | read 5 finished tasks of the class; 4 with every session in ${projects}`,
      'RESULT   | no forecast for this class',
    ])
  })

  it('names where no finished cheap task is recorded', () => {
    const shifts = path.join(root(), 'shift')
    expect(cheapBlock(costLines(shifts, root())).slice(2, 3)).toEqual([`EXPECT   | none: finished cheap tasks not recorded in ${shifts}`])
  })
})

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cheapForecast, cheapForecastOf, cheapRows, projectKey, readCheapTasks, sessionTokens } from '../src/commands/cost/index.js'

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

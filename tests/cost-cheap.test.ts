import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cheapForecast, cheapForecastOf, cheapRows, ClaudeCodeCostSource, costReport, printCost, projectKey, readCheapClasses, readCheapTasks, sessionTokens } from '../src/commands/cost/index.js'
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
      taskLine({ task: '2', session: 's3', card: { kind: 'probe', size: 'M', contour: 'cheap' } }),
      taskLine({ task: 'ladder', card: { kind: 'implement', size: 'S', contour: 'ladder' } }),
      taskLine({ task: 'failed', exit: 1 }),
      taskLine({ task: 'silent', report: false }),
      taskLine({ task: 'cardless', card: undefined }),
      taskLine({ task: 'refused', worktree: null }),
    ])
    const noWindow = path.join(shifts, 'no-window.jsonl')
    expect(readCheapTasks(shifts, noWindow).tasks).toEqual([
      { task: '1', taskClass: 'implement/S', sessions: [{ id: 's1', project: projectKey('/work/mc-1') }, { id: 's2', project: projectKey('/work/mc-1') }], minutes: 4 },
      { task: '2', taskClass: 'probe/M', sessions: [{ id: 's3', project: projectKey('/work/mc-1') }], minutes: 4 },
    ])
    expect(readCheapTasks(path.join(shifts, 'absent'), noWindow)).toEqual({ tasks: [], notes: [] })
  })

  it('counts a session\'s tokens once per request, across the session file and every subagent file under it', () => {
    const projects = root()
    writeSession(projects, '/work/mc-1', 's1', [usageLine(100, 'r1'), usageLine(100, 'r1'), usageLine(50, 'r2'), 'not json'])
    const subagent = path.join(projects, projectKey('/work/mc-1'), 's1', 'subagents', 'workflows', 'wf_1', 'agent-1.jsonl')
    mkdirSync(path.dirname(subagent), { recursive: true })
    writeFileSync(subagent, `${usageLine(7, 'r9')}\n`)
    expect(sessionTokens(projects, { id: 's1', project: projectKey('/work/mc-1') })).toBe(157)
    expect(sessionTokens(projects, { id: 'absent', project: projectKey('/work/mc-1') })).toBeNull()
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
    expect(sessionTokens(projects, { id: 'cheap', project: projectKey('/work/mc-1') })).toBe(2_050)
  })

  it('sums a task\'s sessions and leaves out a task whose session file is gone', () => {
    const KEY = projectKey('/work/mc-1')
    const projects = root()
    writeSession(projects, '/work/mc-1', 's1', [usageLine(100, 'r1')])
    writeSession(projects, '/work/mc-1', 's2', [usageLine(20, 'r1')])
    const tasks = [
      { task: '1', taskClass: 'implement/S', sessions: [{ id: 's1', project: KEY }, { id: 's2', project: KEY }], minutes: 4 },
      { task: '2', taskClass: 'implement/S', sessions: [{ id: 's1', project: KEY }, { id: 'gone', project: KEY }], minutes: 4 },
      { task: '3', taskClass: 'probe/S', sessions: [{ id: 's1', project: KEY }], minutes: 4 },
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
    const noWindow = path.join(shifts, 'no-window.jsonl')
    expect(cheapForecastOf(shifts, noWindow, 'implement/S', projects)).toEqual({ kind: 'forecast', taskClass: 'implement/S', n: 6, tokens: 3500, minutes: 4 })
    expect(cheapForecastOf(shifts, noWindow, 'probe/S', projects)).toEqual({ kind: 'none', taskClass: 'probe/S', n: 0 })
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

function costLines(shifts: string, projects: string, windowJournal = path.join(shifts, 'no-window.jsonl')): string[] {
  const report = costReport(root(), { projectsDir: projects, shiftRoot: shifts, windowJournal, env: { CLAUDECODE: '1' } })
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
      `CONTRACT | finished cheap tasks of class implement/S in the shift journals under ${shifts} and the window journal ${path.join(shifts, 'no-window.jsonl')}`,
      'EXPECT   | tokens ≈ 3,000 from Claude Code shift and window sessions (input, cache writes and output; cache reads left out), minutes ≈ 4 — class implement/S, n=5, median',
      `ACTION   | read 6 finished tasks of the class; 5 with every session in ${projects}`,
      'RESULT   | forecast for the next task of this class',
    ])
  })

  it('moves the forecast when one task of the sample spends differently', () => {
    const { shifts, projects } = cheapWorld([1000, 2000, 9000, 4000, 5000])
    expect(cheapBlock(costLines(shifts, projects))[2]).toBe('EXPECT   | tokens ≈ 4,000 from Claude Code shift and window sessions (input, cache writes and output; cache reads left out), minutes ≈ 4 — class implement/S, n=5, median')
  })

  it('says none with n and the class below five tasks with readable sessions', () => {
    const { shifts, projects } = cheapWorld([1000, 2000, 3000, 4000])
    expect(cheapBlock(costLines(shifts, projects)).slice(2)).toEqual([
      'EXPECT   | none: 4 finished cheap tasks of implement/S from Claude Code shift and window sessions with every session readable, fewer than 5, so no forecast',
      `ACTION   | read 5 finished tasks of the class; 4 with every session in ${projects}`,
      'RESULT   | no forecast for this class',
    ])
  })

  it('names where no finished cheap task is recorded', () => {
    const shifts = path.join(root(), 'shift')
    expect(cheapBlock(costLines(shifts, root())).slice(2, 3)).toEqual([`EXPECT   | none: finished cheap tasks not recorded in ${shifts} or ${path.join(shifts, 'no-window.jsonl')}`])
  })
})

const WINDOW_KEY = projectKey('/work/main')

function windowStart(task: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { event: 'path', task, path: 'cheap', started: '2026-10-01T00:00:00.000Z', session: `w${task}`, worktree: `/work/mc-${task}`, card: { id: Number(task), kind: 'implement', size: 'S', contour: 'cheap' }, ts: 'x', ...fields }
}

function windowClose(task: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { event: 'path', task, path: 'cheap', pr: Number(task), verification: 'run', ended: '2026-10-01T00:06:00.000Z', sessions: [{ id: `w${task}`, project: WINDOW_KEY }], ts: 'x', ...fields }
}

function writeWindow(lines: unknown[]): string {
  const file = path.join(root(), 'ghosts.jsonl')
  writeFileSync(file, `${lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`)
  return file
}

function windowSession(projects: string, id: string, tokens: number): void {
  const file = path.join(projects, WINDOW_KEY, `${id}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${usageLine(tokens, 'r1')}\n`)
}

describe('a closed window task joins the cheap sample through the sessions its closing line records', () => {
  it('(a) a window task closed with its sessions forecasts from them, its minutes from start to ended', () => {
    const projects = root()
    const ids = ['11', '12', '13', '14', '15']
    ids.forEach((id, index) => windowSession(projects, `w${id}`, (index + 1) * 1000))
    const journal = writeWindow(ids.flatMap(id => [windowStart(id), windowClose(id)]))
    expect(cheapForecastOf(root(), journal, 'implement/S', projects)).toEqual({ kind: 'forecast', taskClass: 'implement/S', n: 5, tokens: 3000, minutes: 6 })
  })

  it('(d) reads a window session under the project key the closing line recorded, not under the task worktree', () => {
    const projects = root()
    windowSession(projects, 'w21', 700)
    const journal = writeWindow([windowStart('21'), windowClose('21')])
    expect(readCheapTasks(root(), journal).tasks).toEqual([{ task: '21', taskClass: 'implement/S', sessions: [{ id: 'w21', project: WINDOW_KEY }], minutes: 6 }])
    expect(cheapRows(readCheapTasks(root(), journal).tasks, 'implement/S', projects)).toEqual([{ task: '21', tokens: 700, minutes: 6 }])
  })

  it('(b) a session recorded under two tasks counts for neither and each is named, so no session is counted under two tasks', () => {
    const projects = root()
    windowSession(projects, 'shared', 5000)
    windowSession(projects, 'w33', 100)
    const shared = { sessions: [{ id: 'shared', project: WINDOW_KEY }] }
    const journal = writeWindow([windowStart('31'), windowStart('32'), windowStart('33'), windowClose('31', shared), windowClose('32', shared), windowClose('33')])
    const reading = readCheapClasses(root(), journal, projects)
    expect(cheapRows(readCheapTasks(root(), journal).tasks, 'implement/S', projects)).toEqual([{ task: '33', tokens: 100, minutes: 6 }])
    expect(reading.classes[0]!.notes).toEqual([
      '#31 session shared not recorded: shared is also recorded under #32',
      '#32 session shared not recorded: shared is also recorded under #31',
    ])
  })

  it('(c) a closing line written before task:close recorded sessions leaves the sample as it was and is counted as not recorded', () => {
    const projects = root()
    windowSession(projects, 'w41', 100)
    const old = { event: 'path', task: '40', path: 'cheap', pr: 40, verification: 'run', ts: 'x' }
    const journal = writeWindow(['not json', windowStart('40'), old, windowStart('41'), windowClose('41'), { event: 'path', task: '42', path: 'cheap', ts: 'x' }])
    const { tasks, notes } = readCheapTasks(root(), journal)
    expect(tasks.map(task => task.task)).toEqual(['41'])
    expect(notes).toEqual([{ taskClass: 'implement/S', text: `sessions not recorded on 1 closing line in ${journal}` }])
  })

  it('(e) a close without a verification word stays out of the sample and is named', () => {
    const projects = root()
    windowSession(projects, 'w51', 100)
    const journal = writeWindow([windowStart('51'), windowClose('51', { verification: undefined })])
    const { tasks, notes } = readCheapTasks(root(), journal)
    expect(tasks).toEqual([])
    expect(notes).toEqual([{ taskClass: 'implement/S', text: '#51 close without verification not counted' }])
  })

  it('names a session recorded without its project key, and leaves a window task a shift already counts to the shift', () => {
    const shifts = root()
    writeShift(shifts, 'a', [taskLine({ task: '61', session: 'w61' })])
    const journal = writeWindow([windowStart('61'), windowClose('61'), windowStart('62'), windowClose('62', { sessions: [{ id: 'w62' }] })])
    const { tasks, notes } = readCheapTasks(shifts, journal)
    expect(tasks.map(task => task.task)).toEqual(['61'])
    expect(tasks[0]!.sessions).toEqual([{ id: 'w61', project: projectKey('/work/mc-1') }])
    expect(notes).toEqual([{ taskClass: 'implement/S', text: `#62 session w62 project not recorded in ${journal}` }])
  })

  it('prints each task left out of the class in ACTION', () => {
    const projects = root()
    const journal = writeWindow([windowStart('71'), windowClose('71', { verification: undefined })])
    const shifts = path.join(root(), 'shift')
    expect(cheapBlock(costLines(shifts, projects, journal))[3]).toBe(`ACTION   | read 0 finished tasks of the class; 0 with every session in ${projects}; #71 close without verification not counted`)
  })
})

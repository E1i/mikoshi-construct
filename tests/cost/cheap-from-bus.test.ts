import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cheapRows, projectKey, readCheapClasses, readCheapTasks } from '../../src/commands/cost/index.js'
import { busCard, writeBus, writeLegacy } from '../cost-bus.js'

const WINDOW_TREE = '/work/main'
const CARD_TREE = '/work/mc-90'

function root(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-cheap-bus-')))
}

function session(projects: string, worktree: string, id: string, tokens: number): void {
  const file = path.join(projects, projectKey(worktree), `${id}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ requestId: 'r1', message: { role: 'assistant', usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } })}\n`)
}

function windowLines(task: string): Record<string, unknown>[] {
  return [
    { event: 'path', task, path: 'cheap', started: '2026-10-01T00:00:00.000Z', session: `w${task}`, worktree: WINDOW_TREE, card: { id: Number(task), kind: 'implement', size: 'S', contour: 'cheap' }, ts: '2026-10-01T00:00:00.000Z' },
    { event: 'path', task, path: 'cheap', pr: Number(task), verification: 'run', ended: '2026-10-01T00:06:00.000Z', sessions: [{ id: `w${task}`, project: projectKey(WINDOW_TREE) }], ts: '2026-10-01T00:06:00.000Z' },
  ]
}

const CARD_CLOSE_IN_JOURNAL = { event: 'path', task: '90', path: 'cheap', pr: 90, verification: 'run', ended: '2026-10-14T00:10:00.000Z', sessions: [{ id: 's90', project: projectKey(CARD_TREE) }, { id: 'a90', project: projectKey(CARD_TREE) }], ts: '2026-10-14T00:10:00.000Z' }

describe('cost cheap reads the bus', () => {
  it('cost cheap from the bus matches the journal figures for one period', () => {
    const projects = root()
    const windowTasks = ['11', '12', '13', '14', '15']
    windowTasks.forEach((task, index) => session(projects, WINDOW_TREE, `w${task}`, (index + 1) * 1000))
    session(projects, CARD_TREE, 's90', 300)
    session(projects, CARD_TREE, 'a90', 200)
    const bus = path.join(root(), 'bus.db')
    writeBus(bus, [busCard(90, {
      started: '2026-10-14T00:00:00.000Z',
      ended: CARD_CLOSE_IN_JOURNAL.ended,
      start: { session: 's90', worktree: CARD_TREE, branch: 'b' },
      answered: { ts: '2026-10-14T00:05:00.000Z', answer: { session: 'a90', worktree: CARD_TREE } },
    })])
    writeLegacy(bus, [...windowTasks.flatMap(windowLines), CARD_CLOSE_IN_JOURNAL])

    const reading = readCheapClasses(path.join(root(), 'no-shifts'), projects, bus)
    expect(reading.classes.map(({ forecast, notes }) => ({ forecast, notes }))).toEqual([
      { forecast: { kind: 'none', taskClass: 'implement/M', n: 1 }, notes: [] },
      { forecast: { kind: 'forecast', taskClass: 'implement/S', n: 5, tokens: 3000, minutes: 6 }, notes: [] },
    ])
    const { tasks } = readCheapTasks(path.join(root(), 'no-shifts'), bus)
    expect(cheapRows(tasks, 'implement/M', projects)).toEqual([{ task: '90', tokens: 300 + 200, minutes: 10 }])
  })
})

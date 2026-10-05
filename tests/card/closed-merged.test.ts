import { describe, expect, it } from 'vitest'
import { closedTasks, mergedTasks } from '../../src/card/closed.js'

const JOURNAL = [
  { event: 'path', task: '10', path: 'cheap', started: 't' },
  { event: 'path', task: '10', path: 'cheap', pr: 500, verification: 'run' },
  { event: 'path', task: '11', path: 'cheap', pr: 501, verification: 'run' },
  { event: 'merge', task: '11', pr: 501, by: 'owner', commit: 'abc' },
  { event: 'path', task: '12', path: 'cheap', report: '/tmp/r.md', verification: 'report' },
  { event: 'merge', task: 'ghosts-v011', by: 'owner', commit: 'def' },
].map(line => JSON.stringify(line)).join('\n')

describe('mergedTasks', () => {
  it('holds the tasks with a merge line and the probes closed by report', () => {
    expect([...mergedTasks(JOURNAL)].sort()).toEqual(['11', '12', 'ghosts-v011'])
  })

  it('does not hold a task that is only done, or only started, and leaves closedTasks as it was', () => {
    expect(mergedTasks(JOURNAL).has('10')).toBe(false)
    expect(mergedTasks('not json\n{"event":"start","task":"13"}\n').size).toBe(0)
    expect(mergedTasks(null).size).toBe(0)
    expect([...closedTasks(JOURNAL).keys()].sort()).toEqual(['10', '11', '12'])
  })
})

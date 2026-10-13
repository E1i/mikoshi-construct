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

describe('mergedTasks over the journal half of history and the bus', () => {
  const journal = [
    JSON.stringify({ event: 'merge', task: '608', pr: 730, by: 'E1i', commit: '29ab6f00', ts: '2026-10-10T19:00:00.000Z' }),
    JSON.stringify({ event: 'merge', task: '842', pr: 791, by: 'E1i', commit: 'f6525f36', ts: '2026-10-12T17:05:45.291Z' }),
  ].join('\n')

  it('keeps a card merged before the journal half of history ended merged whatever the bus holds, as #608 the bus stopped', () => {
    expect(mergedTasks(journal, new Map([['608', 'stopped']])).has('608')).toBe(true)
    expect(closedTasks(journal, new Map([['608', 'stopped']])).has('608')).toBe(false)
  })

  it('takes a merge after the journal half of history from the bus alone', () => {
    expect(mergedTasks(journal).has('842')).toBe(false)
    expect(mergedTasks(journal, new Map([['842', 'closed']])).has('842')).toBe(true)
    expect(mergedTasks(journal, new Map([['928', 'merged'], ['889', 'running']]))).toEqual(new Set(['608', '928']))
  })
})

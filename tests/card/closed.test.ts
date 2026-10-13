import { describe, expect, it } from 'vitest'
import { closedTasks, JOURNAL_HISTORY_ENDS, writtenBeforeHistoryEnds } from '../../src/card/closed.js'

describe('closedTasks', () => {
  it('a start line does not close, a closing path line with a verification does, and a line that is not JSON is skipped', () => {
    const journal = [
      JSON.stringify({ event: 'path', task: '77', path: 'cheap', verification: 'run' }),
      JSON.stringify({ event: 'start', task: '78' }),
      JSON.stringify({ event: 'path', task: '79', path: 'cheap' }),
      'not json',
      'null',
    ].join('\n')
    expect([...closedTasks(journal)]).toEqual([['77', 'run']])
    expect(closedTasks(null).size).toBe(0)
  })
})

describe('closedTasks over the journal half of history and the bus', () => {
  const journal = [
    JSON.stringify({ event: 'path', task: '842', path: 'cheap', pr: 791, verification: 'run', ts: '2026-10-12T17:03:59.000Z' }),
    JSON.stringify({ event: 'path', task: '889', path: 'ladder', pr: 786, verification: 'run', ts: '2026-10-12T17:07:15.949Z' }),
    JSON.stringify({ event: 'path', task: '928', path: 'cheap', pr: 803, verification: 'run', ts: '2026-10-13T13:03:01.409Z' }),
    JSON.stringify({ event: 'path', task: '700', path: 'cheap', pr: 600, verification: 'review' }),
  ].join('\n')

  it('holds a card the bus closed or merged with no path line in the journal, as #855', () => {
    const closed = closedTasks(journal, new Map([['855', 'closed'], ['928', 'merged'], ['930', 'queued']]))
    expect(closed.get('855')).toBe('closed')
    expect(closed.has('930')).toBe(false)
  })

  it('reads a path line written once the journal half of history ended only through the bus, so #889 stays open while the bus runs it', () => {
    expect(JOURNAL_HISTORY_ENDS).toBe('2026-10-12T17:04:00.000Z')
    const closed = closedTasks(journal, new Map([['889', 'running'], ['928', 'merged']]))
    expect([...closed]).toEqual([['842', 'run'], ['700', 'review'], ['928', 'merged']])
  })

  it('keeps the verification of a card closed in the journal half of history when the bus later ends it too', () => {
    expect(closedTasks(journal, new Map([['842', 'merged'], ['700', 'closed']])).get('842')).toBe('run')
    expect(closedTasks(journal, new Map([['842', 'merged'], ['700', 'closed']])).get('700')).toBe('review')
  })

  it('puts a line written at the very instant the journal half of history ends outside it', () => {
    const atTheEnd = JSON.stringify({ event: 'path', task: '901', path: 'cheap', pr: 900, verification: 'run', ts: JOURNAL_HISTORY_ENDS })
    const justBefore = JSON.stringify({ event: 'path', task: '902', path: 'cheap', pr: 901, verification: 'run', ts: '2026-10-12T17:03:59.999Z' })
    expect([...closedTasks([atTheEnd, justBefore].join('\n'), new Map())]).toEqual([['902', 'run']])
  })

  it('counts every journal line, before and after the cutoff, when no bus is connected', () => {
    const atTheEnd = JSON.stringify({ event: 'path', task: '901', path: 'cheap', pr: 900, verification: 'run', ts: JOURNAL_HISTORY_ENDS })
    const justBefore = JSON.stringify({ event: 'path', task: '902', path: 'cheap', pr: 901, verification: 'run', ts: '2026-10-12T17:03:59.999Z' })
    expect([...closedTasks([atTheEnd, justBefore].join('\n'))]).toEqual([['901', 'run'], ['902', 'run']])
  })

  it('decides a line before the journal half of history ends by its ts, and a line without a readable ts as before', () => {
    expect(writtenBeforeHistoryEnds({ ts: '2026-10-12T17:03:59.999Z' })).toBe(true)
    expect(writtenBeforeHistoryEnds({ ts: JOURNAL_HISTORY_ENDS })).toBe(false)
    expect(writtenBeforeHistoryEnds({ ts: 'x' })).toBe(true)
    expect(writtenBeforeHistoryEnds({})).toBe(true)
  })
})

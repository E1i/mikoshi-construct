import type { BusEvent } from '../../scripts/core/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unsatisfiedDependencies } from '../../scripts/core/card-automaton.js'
import { appendEvent, openBus } from '../../scripts/core/db.js'
import { CARD_VERIFIED } from '../../scripts/core/events.js'
import { reduce } from '../../scripts/core/reducer.js'
import { closedFromBus, closedTasks, endedCards, JOURNAL_HISTORY_ENDS, mergedTasks, writtenBeforeHistoryEnds } from '../../src/card/closed.js'

const busRoots: string[] = []

afterEach(() => {
  for (const root of busRoots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function unsatisfiedIn(events: Omit<BusEvent, 'ts' | 'head' | 'dedupeKey'>[], depends: number[]): number[] {
  const root = mkdtempSync(path.join(tmpdir(), 'satisfied-'))
  busRoots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  try {
    events.forEach((event, at) => appendEvent(db, { ...event, ts: `2026-10-11T00:00:0${at}.000Z`, head: null, dedupeKey: `${event.type}:${event.cardId}:${at}` }))
    reduce(db)
    return unsatisfiedDependencies(db)(depends)
  }
  finally {
    db.close()
  }
}

describe('unsatisfiedDependencies, the one predicate launch and task:start read', () => {
  it('a probe closed by report is a satisfied dependency from its card.verified on, before the close node writes card.closed', () => {
    const verified = { type: CARD_VERIFIED, actor: 'worker:task-close:by-hand', cardId: 1, pr: null, payload: { verification: 'run', report: '/reports/1.md' }, legacy: false }
    expect(unsatisfiedIn([verified], [1, 2])).toEqual([2])
  })

  it('a card.verified that names a pull request satisfies nothing by itself', () => {
    expect(unsatisfiedIn([{ type: CARD_VERIFIED, actor: 'worker:task-close:by-hand', cardId: 3, pr: 30, payload: { verification: 'run', pr: 30 }, legacy: false }], [3])).toEqual([3])
  })

  it('a merge line or a probe path line closed by report in the journal half of history is a satisfied dependency, a path line naming a PR is not, nor a merge line written once that half ended', () => {
    const lines = [
      { type: 'merge', actor: 'worker:legacy:journal', cardId: 5, pr: 50, payload: { event: 'merge', task: '5', pr: 50 }, legacy: true },
      { type: 'path', actor: 'worker:legacy:journal', cardId: 6, pr: null, payload: { event: 'path', task: '6', verification: 'run', report: '/reports/6.md' }, legacy: true },
      { type: 'path', actor: 'worker:legacy:journal', cardId: 7, pr: 70, payload: { event: 'path', task: '7', verification: 'run', pr: 70 }, legacy: true },
      { type: 'merge', actor: 'worker:legacy:journal', cardId: 8, pr: 80, payload: { event: 'merge', task: '8', pr: 80, ts: JOURNAL_HISTORY_ENDS }, legacy: true },
    ]
    expect(unsatisfiedIn(lines, [5, 6, 7, 8])).toEqual([7, 8])
  })
})

describe('closedTasks and mergedTasks without a journal', () => {
  it('closedTasks and mergedTasks read the bus card states with no journal text', () => {
    const bus = new Map([['77', 'merged'], ['78', 'closed'], ['79', 'running'], ['80', 'parked']])
    expect([...closedTasks(null, bus)]).toEqual([['77', 'merged'], ['78', 'closed']])
    expect([...mergedTasks(null, bus)]).toEqual(['77', '78'])
    expect(closedTasks(null, new Map()).size).toBe(0)
    expect(mergedTasks(null, new Map()).size).toBe(0)
    expect([...endedCards(bus)]).toEqual(['77', '78'])
    expect(endedCards(undefined).size).toBe(0)
  })
})

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

describe('closedFromBus', () => {
  it('closed cards from the bus equal the closed cards of the journal over one period', () => {
    const lines = [
      { event: 'path', task: '842', path: 'cheap', pr: 791, verification: 'run', ts: '2026-10-12T17:03:59.000Z' },
      { event: 'path', task: '700', path: 'cheap', pr: 600, verification: 'review' },
      { event: 'path', task: '930', path: 'cheap', card: { id: 930 }, ts: '2026-10-12T17:05:00.000Z' },
      { event: 'path', task: '889', path: 'ladder', pr: 786, verification: 'run', ts: '2026-10-12T17:07:15.949Z' },
      { event: 'path', task: '928', path: 'cheap', pr: 803, verification: 'review', ts: '2026-10-13T13:03:01.409Z' },
    ]
    const bus = new Map([['889', 'merged'], ['928', 'closed'], ['930', 'running']])
    const fromJournal = closedTasks(lines.map(line => JSON.stringify(line)).join('\n'))
    const fromBus = closedFromBus(lines, bus)
    expect([...fromBus.keys()].sort()).toEqual([...fromJournal.keys()].sort())
    expect(fromBus.get('842')).toBe(fromJournal.get('842'))
    expect(fromBus.get('700')).toBe(fromJournal.get('700'))
    expect(fromBus.has('930')).toBe(false)
  })
})

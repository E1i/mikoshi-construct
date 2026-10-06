import type { ParkedTask } from '../../../src/card/parking.js'
import { describe, expect, it } from 'vitest'
import { parseParkingFile } from '../../../src/card/parking.js'
import { choose, latestStops, standingStops } from '../../shift/parking.js'

function parked(id: number, kind = 'implement/runner/S/cheap/auto', who = 'shift', depends = '—'): ParkedTask {
  const parsed = parseParkingFile(`${id}.md`, `card: #${id} task-${id} [${kind}] · depends ${depends} · blocks —\nbranch: feat/${id}\ntouches: scripts/${id}/**\nwho: ${who}\n\ndo ${id}\n`)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  return parsed.parked
}

const stop = (task: string, at: string, worktree: string | null, extra: object = {}): object => ({ event: 'stop', task, at, why: 'w', worktree, shift: '/s', session: null, ts: 't', ...extra })
const journal = (...entries: object[]): string => `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`

describe('choose with a standing stop and a ladder card', () => {
  it('shift takes a ladder card with who shift: the parking choice chooses it like a cheap card', () => {
    const choice = choose([parked(1, 'implement/runner/M/ladder/owner'), parked(2, 'implement/runner/M/ladder/owner', 'window')], new Set(), new Set())
    expect(choice.chosen.map(task => task.id)).toEqual(['1'])
    expect(choice.left).toEqual([{ id: '2', reason: 'who window' }])
  })

  it('a ladder card whose depends are not merged waits for them like any card', () => {
    expect(choose([parked(1, 'implement/runner/M/ladder/owner', 'shift', '#9')], new Set(), new Set()).left).toEqual([{ id: '1', reason: 'depends #9 not merged' }])
  })

  it('takes a ladder card that is a probe and a cheap card', () => {
    expect(choose([parked(1, 'probe/runner/S/ladder/none'), parked(2)], new Set(), new Set()).chosen.map(task => task.id)).toEqual(['1', '2'])
  })

  it('leaves a card with a waiting stop as waits <at>, before its depends and its ladder contour', () => {
    const waiting = new Map([['1', 'question' as const], ['2', 'hash' as const], ['3', 'fault' as const]])
    const choice = choose([parked(1), parked(2, 'implement/runner/M/ladder/owner'), parked(3, 'implement/runner/S/cheap/auto', 'shift', '#9'), parked(4, 'implement/runner/S/cheap/auto', 'shift', '#9')], new Set(), new Set(), waiting)
    expect(choice.left).toEqual([{ id: '1', reason: 'waits question' }, { id: '2', reason: 'waits hash' }, { id: '3', reason: 'waits fault' }, { id: '4', reason: 'depends #9 not merged' }])
  })

  it('a closed card is closed, not waiting, and a window card is who window', () => {
    const waiting = new Map([['1', 'merge' as const], ['2', 'fault' as const]])
    expect(choose([parked(1), parked(2, undefined, 'window')], new Set(['1']), new Set(), waiting).left).toEqual([{ id: '1', reason: 'closed' }, { id: '2', reason: 'who window' }])
  })
})

describe('the stop journal readers', () => {
  it('reads the latest stop of each card and ignores other events and broken lines', () => {
    const text = `${journal(stop('1', 'question', '/w'), { event: 'path', task: '1', at: 'hash' }, stop('1', 'boundary', '/w'), stop('2', 'bogus', null))}not json\n`
    expect([...latestStops(text)].map(([task, entry]) => [task, entry.at])).toEqual([['1', 'boundary']])
  })

  it('a stop stands while its tree exists; a stop with no tree stands only at hash', () => {
    const stops = latestStops(journal(stop('1', 'question', '/there'), stop('2', 'question', '/gone'), stop('3', 'hash', null), stop('4', 'fault', null)))
    expect([...standingStops(stops, target => target === '/there')]).toEqual([['1', 'question'], ['3', 'hash']])
  })

  it('a released stop does not stand, whatever its tree', () => {
    const stops = latestStops(journal(stop('1', 'hash', '/there'), stop('2', 'hash', null), stop('3', 'question', '/there')))
    expect([...standingStops(stops, () => true, entry => entry.task !== '3')]).toEqual([['3', 'question']])
  })

  it('an empty journal holds no stop', () => {
    expect(latestStops(null).size).toBe(0)
  })
})

describe('choose with a created scripts/ghosts file', () => {
  const touching = (file: string): ParkedTask => {
    const parsed = parseParkingFile('1.md', `card: #1 task-1 [implement/runner/S/cheap/auto] · depends — · blocks —\nbranch: feat/1\ntouches: ${file}\nwho: shift\n\ndo 1\n`)
    if (parsed.kind === 'refused')
      throw new Error(parsed.reason)
    return parsed.parked
  }

  it('a card creating an unclassified scripts/ghosts file is left to classify', () => {
    const choice = choose([touching('scripts/ghosts/new.ts')], new Set(), new Set(), new Map(), () => true)
    expect(choice.left).toEqual([{ id: '1', reason: 'classify scripts/ghosts/new.ts in owner-merges.md' }])
  })

  it('a card whose scripts/ghosts file exists, or a file elsewhere, is taken', () => {
    expect(choose([touching('scripts/ghosts/old.ts')], new Set(), new Set(), new Map(), () => false).chosen).toHaveLength(1)
    expect(choose([touching('scripts/shift/new.ts')], new Set(), new Set(), new Map(), () => true).chosen).toHaveLength(1)
  })
})

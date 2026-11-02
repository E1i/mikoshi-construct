import type { BusEvent, WatchDeps } from '../../window/watch.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_CLOSED, CARD_STOPPED, MERGE_DONE, PR_CLOSED, REVIEW_RECORDED, WORKER_DOWN } from '../../core/events.js'
import { WatchRefusal } from '../../window/watch-refusal.js'
import { ONCE_STORE, OnceStore } from '../../window/watch-store.js'
import { busLine, CATCHUP_LAG, caughtUpLine, deliverOnce, parseWatchArgs, runTail, selectOnce, TAIL, tailLine } from '../../window/watch.js'

const CURSOR = 10192
const TAIL_ID = CURSOR + 500

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function handoffDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'watchcatchup-'))
  dirs.push(dir)
  return dir
}

function memoryDeps(events: BusEvent[], end: () => number, emitted: string[] = []): WatchDeps {
  return {
    bus: 'memory',
    lastBusId: end,
    busEventsAfter: id => events.filter(event => event.id > id),
    observedUpTo: () => [],
    witnessedUpTo: () => [],
    deniedUpTo: () => [],
    windowPrs: () => new Set(),
    ownRequest: () => false,
    observedHeads: () => [],
    stalls: () => [],
    stuck: () => [],
    wokenStalls: () => new Map(),
    rememberStalls: () => {},
    emit: async (line) => {
      emitted.push(line)
    },
    beforeCommit: async () => {},
    beat: () => {},
  }
}

function event(id: number, type: string, cardId: number | null, pr: number | null, head: string | null = null): BusEvent {
  return { id, type, cardId, pr, head, payload: JSON.stringify({ n: id }) }
}

function storeAt(handoff: string, busId: number): OnceStore {
  return OnceStore.open(path.join(handoff, ONCE_STORE), { file: path.join(handoff, 'none.json'), text: undefined }, () => ({ offset: 0, busId }))
}

describe('watch --once catches up a lagging cursor', () => {
  it('a cursor 500 events behind gets a live event or the current state in one watch --once', async () => {
    const stale = [
      event(CURSOR + 10, CARD_STOPPED, 1, 11),
      event(CURSOR + 120, REVIEW_RECORDED, 1, 11),
      event(CURSOR + 200, MERGE_DONE, 2, 12),
      event(CURSOR + 300, CARD_CLOSED, 2, 12),
      event(CURSOR + 400, CARD_STOPPED, 3, 13),
    ]
    const handoff = handoffDir()
    const store = storeAt(handoff, CURSOR)
    const emitted: string[] = []
    try {
      await deliverOnce(store, memoryDeps(stale, () => TAIL_ID, emitted))
      expect(emitted).toEqual([[caughtUpLine(CURSOR, TAIL_ID), busLine(stale[1]!), busLine(stale[3]!), busLine(stale[4]!)].join('\n')])
      expect(store.cursor()).toEqual({ offset: 0, busId: TAIL_ID })
    }
    finally {
      store.close()
    }

    const live = event(TAIL_ID + 1, CARD_STOPPED, 4, 14)
    let end = TAIL_ID
    const quiet = memoryDeps([live], () => end)
    expect(selectOnce({ offset: 0, busId: CURSOR }, quiet)).toEqual({ line: null, cursor: { offset: 0, busId: TAIL_ID } })
    end = TAIL_ID + 1
    expect(selectOnce({ offset: 0, busId: TAIL_ID }, quiet)).toEqual({ line: busLine(live), cursor: { offset: 0, busId: TAIL_ID + 1 } })
    expect(selectOnce({ offset: 0, busId: TAIL_ID - CATCHUP_LAG }, memoryDeps(stale, () => TAIL_ID))).toBeUndefined()
    expect(selectOnce({ offset: 0, busId: CURSOR }, memoryDeps(stale, () => TAIL_ID), 2)).toEqual({ line: [caughtUpLine(CURSOR, TAIL_ID), busLine(stale[3]!)].join('\n'), cursor: { offset: 0, busId: TAIL_ID } })
  })

  it('a catch-up keeps the latest event per card, per pull request without a card and per type without either, in bus order, up to the tail and never of a superseded head', () => {
    const SUPERSEDED_PR = 15
    const events = [
      event(CURSOR + 10, CARD_STOPPED, 1, 11),
      event(CURSOR + 20, MERGE_DONE, 2, 12),
      event(CURSOR + 30, REVIEW_RECORDED, 1, 11),
      event(CURSOR + 40, REVIEW_RECORDED, 3, SUPERSEDED_PR, 'old'),
      event(CURSOR + 50, MERGE_DONE, null, 16),
      event(CURSOR + 60, PR_CLOSED, null, 16),
      event(CURSOR + 70, WORKER_DOWN, null, null),
      event(CURSOR + 75, CARD_CLOSED, null, null),
      event(CURSOR + 80, WORKER_DOWN, null, null),
      event(TAIL_ID + 5, CARD_STOPPED, 4, 17),
    ]
    const deps = { ...memoryDeps(events, () => TAIL_ID), observedHeads: (pr: number) => pr === SUPERSEDED_PR ? ['old', 'new'] : [] }
    const kept = [events[1]!, events[2]!, events[5]!, events[7]!, events[8]!]
    expect(selectOnce({ offset: 0, busId: CURSOR }, deps)).toEqual({ line: [caughtUpLine(CURSOR, TAIL_ID), ...kept.map(busLine)].join('\n'), cursor: { offset: 0, busId: TAIL_ID } })
  })

  it('--tail refuses a bus that ends before the cursor and leaves the cursor where it was', () => {
    const handoff = handoffDir()
    storeAt(handoff, CURSOR).close()
    expect(() => runTail(handoff, memoryDeps([], () => CURSOR - 1))).toThrow(WatchRefusal)
    const store = storeAt(handoff, 0)
    try {
      expect(store.cursor()).toEqual({ offset: 0, busId: CURSOR })
    }
    finally {
      store.close()
    }
  })

  it('the agent moves the cursor to the bus tail with one command', () => {
    expect(parseWatchArgs([TAIL])).toEqual({ once: false, tail: true })
    expect(parseWatchArgs([TAIL, '--once'])).toBeUndefined()
    const handoff = handoffDir()
    storeAt(handoff, CURSOR).close()
    expect(runTail(handoff, memoryDeps([], () => TAIL_ID))).toBe(tailLine(CURSOR, TAIL_ID))
    const store = storeAt(handoff, 0)
    try {
      expect(store.cursor()).toEqual({ offset: 0, busId: TAIL_ID })
    }
    finally {
      store.close()
    }
  })
})

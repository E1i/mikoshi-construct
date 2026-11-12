import type { DatabaseSync } from 'node:sqlite'
import type { OrderedCard, SizedTask } from '../../nodes/launch/lane-assign.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { startOrder } from '../../nodes/launch/lane-assign.js'
import { launchCandidates } from '../../nodes/launch/launch-candidates.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-07T10:00:00.000Z'
const LANES = 2
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function openedBus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'start-order-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function admit(db: DatabaseSync, id: number, touches: string, priority: string | null = null): void {
  const line = priority === null ? '' : `priority: ${priority}\n`
  const text = `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n${line}\nDo the thing.\n`
  busCardEvents(db, 's1', () => LANES)({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
  reduce(db, 'pending', busProjections())
}

function start(db: DatabaseSync, id: number): void {
  appendEvent(db, { ts: TS, type: CARD_STARTED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${id}`, payload: {}, legacy: false })
  reduce(db, 'pending', busProjections())
}

function card(cardId: number, shape: Partial<OrderedCard> = {}): OrderedCard {
  return { cardId, depends: [], priority: null, ...shape }
}

function sized(size: SizedTask['card']['size']): SizedTask {
  return { card: { size } }
}

function ordered(cards: readonly OrderedCard[]): number[] {
  return [...cards].sort(startOrder(cards)).map(each => each.cardId)
}

describe('startOrder', () => {
  it('a p0 card that blocks nothing sorts before a card with no priority that blocks four', () => {
    const cards = [
      card(1654),
      card(1655, { depends: [1654] }),
      card(1656, { depends: [1654] }),
      card(1657, { depends: [1654] }),
      card(1658, { depends: [1654] }),
      card(1693, { priority: 'p0' }),
    ]
    expect(ordered(cards)[0]).toBe(1693)
    expect(ordered(cards)[1]).toBe(1654)
  })

  it('p0 sorts before p1 before p2 before no priority', () => {
    const cards = [card(1), card(2, { priority: 'p2' }), card(3, { priority: 'p1' }), card(4, { priority: 'p0' })]
    expect(ordered(cards)).toEqual([4, 3, 2, 1])
  })

  it('a card a p0 depends on through a chain sorts as p0', () => {
    const cards = [
      card(1, { priority: 'p1' }),
      card(2),
      card(3, { depends: [4] }),
      card(4),
      card(5, { depends: [3], priority: 'p0' }),
    ]
    expect(ordered(cards)).toEqual([4, 3, 5, 1, 2])
  })

  it('a card takes the best priority of those it blocks and keeps its own when that is better', () => {
    const cards = [
      card(1, { priority: 'p1' }),
      card(2, { depends: [3], priority: 'p2' }),
      card(3),
      card(4, { depends: [5], priority: 'p2' }),
      card(5, { priority: 'p0' }),
    ]
    expect(ordered(cards)).toEqual([5, 1, 3, 2, 4])
  })

  it('a card does not take the priority of the card it depends on', () => {
    const cards = [card(4, { depends: [2] }), card(2, { priority: 'p2' }), card(3)]
    expect(ordered(cards)).toEqual([2, 3, 4])
  })

  it('of two cards of equal priority the one that blocks more sorts first, then the lower number', () => {
    const cards = [
      card(1, { priority: 'p1' }),
      card(2, { priority: 'p1' }),
      card(3, { priority: 'p1' }),
      card(4, { depends: [3], priority: 'p1' }),
    ]
    expect(ordered(cards)).toEqual([3, 1, 2, 4])
  })

  it('a card with a longer weighted chain behind it starts before a card with more but shorter dependents', () => {
    const cards = [
      card(1674),
      card(1675, { depends: [1674], task: sized('XS') }),
      card(1676, { depends: [1674], task: sized('XS') }),
      card(1677, { depends: [1674], task: sized('XS') }),
      card(1711),
      card(1712, { depends: [1711], task: sized('M') }),
    ]
    expect(ordered(cards).slice(0, 2)).toEqual([1711, 1674])
  })

  it('the chain behind a card weighs each card on it by its size', () => {
    const cards = [
      card(10),
      card(11, { depends: [10], task: sized('S') }),
      card(12, { depends: [11], task: sized('S') }),
      card(20),
      card(21, { depends: [20], task: sized('L') }),
    ]
    expect(ordered(cards).slice(0, 2)).toEqual([20, 10])
  })

  it('a higher priority still starts first whatever the chain behind it', () => {
    const cards = [
      card(1),
      card(2, { depends: [1], task: sized('L') }),
      card(3, { depends: [2], task: sized('L') }),
      card(4, { priority: 'p2' }),
    ]
    expect(ordered(cards)[0]).toBe(4)
  })

  it('a cycle of depends ends the walk and still takes the best priority in it', () => {
    const cards = [card(1, { depends: [2] }), card(2, { depends: [1], priority: 'p0' }), card(3, { priority: 'p1' })]
    expect(ordered(cards)).toEqual([1, 2, 3])
  })

  it('a p0 card that overlaps a running card reserves nothing and the next card still starts', () => {
    const db = openedBus()
    admit(db, 1, 'src/a.ts')
    start(db, 1)
    admit(db, 2, 'src/b.ts')
    admit(db, 3, 'src/a.ts', 'p0')
    expect(launchCandidates(db, () => false).map(candidate => candidate.cardId)).toEqual([2])
  })
})

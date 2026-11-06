import type { OrderedCard } from '../../nodes/launch/lane-assign.js'
import { describe, expect, it } from 'vitest'
import { startOrder } from '../../nodes/launch/lane-assign.js'

function card(cardId: number, shape: Partial<OrderedCard> = {}): OrderedCard {
  return { cardId, depends: [], priority: null, ...shape }
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

  it('a cycle of depends ends the walk and still takes the best priority in it', () => {
    const cards = [card(1, { depends: [2] }), card(2, { depends: [1], priority: 'p0' }), card(3, { priority: 'p1' })]
    expect(ordered(cards)).toEqual([1, 2, 3])
  })
})

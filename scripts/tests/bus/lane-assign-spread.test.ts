import type { ShiftTask } from '../../../src/card/task-file.js'
import type { LaneCard, LiveLane } from '../../nodes/launch/lane-assign.js'
import { describe, expect, it } from 'vitest'
import { parseParkingFile } from '../../../src/card/parking.js'
import { chooseLane } from '../../nodes/launch/lane-assign.js'

function task(id: number, touches: string): ShiftTask {
  const text = `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
  const parsed = parseParkingFile(`${id}.md`, text)
  if (parsed.kind !== 'parked')
    throw new Error(parsed.reason)
  return parsed.parked.task
}

function laneCard(id: number, touches: string, depends: number[] = []): LaneCard {
  return { cardId: id, depends, task: task(id, touches) }
}

function laid(cards: readonly LaneCard[], count: number): LiveLane[] {
  return cards.reduce<LiveLane[]>((live, card) => [...live, { ...card, lane: chooseLane(card, live, count).lane }], [])
}

describe('independent cards spread over all lanes', () => {
  it('two cards that depend on one foundation and not on each other take different lanes', () => {
    const lanes = laid([laneCard(1, 'package.json'), laneCard(2, 'eslint.config.mjs', [1]), laneCard(3, 'AGENTS.md', [1])], 3)
    expect(lanes[1]!.lane).toBe(lanes[0]!.lane)
    expect(lanes[2]!.lane).not.toBe(lanes[1]!.lane)
  })

  it('a card that overlaps a live card still joins its lane', () => {
    const lanes = laid([laneCard(1, 'package.json'), laneCard(2, 'eslint.config.mjs', [1]), laneCard(3, 'package.json', [1])], 3)
    expect(lanes[2]!.lane).toBe(lanes[0]!.lane)
  })

  it('with no free lane a dependent card falls back to its foundation lane', () => {
    const lanes = laid([laneCard(1, 'a.md'), laneCard(2, 'b.md', [1]), laneCard(3, 'c.md', [1])], 1)
    expect(lanes.every(card => card.lane === 'lane-1')).toBe(true)
    const two = laid([laneCard(1, 'a.md'), laneCard(2, 'b.md', [1]), laneCard(4, 'd.md'), laneCard(3, 'c.md', [1])], 2)
    expect(two[3]).toMatchObject({ lane: 'lane-1' })
  })
})

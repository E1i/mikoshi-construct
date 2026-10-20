import type { BusCard, BusFacts } from '../../src/commands/board/bus.js'
import { describe, expect, it } from 'vitest'
import { backlogLines, flowLines, matrixLines, pulseLines, screenLines, servicesLines } from '../../src/commands/board/screens.js'
import { LORE, PLAIN_LORE } from '../../src/ui/lore.js'

function card(id: number, state: string | null, lane: string | null = null, line: string | null = null): BusCard {
  return { id, state, lane, line, since: null, body: true, closed: false }
}

function noFacts(overrides: Partial<BusFacts> = {}): BusFacts {
  return { at: '2026-10-02T12:00:00.000Z', goal: null, pulse: null, slots: [], cards: [], services: [], matrices: [], failure: null, reviewQueue: 0, ...overrides }
}

describe('the board screens', () => {
  it('flow puts queued in planned, running and changes in work, in_review in review, ready in ready to merge, and leaves every other state out', () => {
    const cards = [card(1, 'queued'), card(2, 'running'), card(3, 'changes'), card(4, 'in_review'), card(5, 'ready'), card(6, 'merged'), card(7, 'fell'), card(8, null)]
    expect(flowLines(cards, PLAIN_LORE)).toEqual([
      'planned (1): #1',
      'in work (2): #2 · #3',
      'in review (1): #4',
      'ready to merge (1): #5',
    ])
    expect(flowLines([], PLAIN_LORE)).toEqual(['planned (0): —', 'in work (0): —', 'in review (0): —', 'ready to merge (0): —'])
  })

  it('backlog groups every card by lane, named lanes sorted and the cards with no lane last', () => {
    const cards = [card(1, 'queued', 'b', 'card: #1 alpha'), card(2, null, null, null), card(3, 'merged', 'a', '#3 gamma'), card(4, 'fell', 'b', 'card:#4 delta')]
    expect(backlogLines(cards, PLAIN_LORE)).toEqual([
      'a (1)',
      '  #3 gamma · merged',
      'b (2)',
      '  #1 alpha · queued',
      '  #4 delta · fell',
      'no lane (1)',
      '  #2 · —',
    ])
    expect(backlogLines([card(1, 'queued', 'a', 'card: #1 alpha')], PLAIN_LORE)).toEqual(['a (1)', '  #1 alpha · queued'])
  })

  it('services names each running session and says so when none runs', () => {
    expect(servicesLines(noFacts(), PLAIN_LORE)).toEqual(['no session is running'])
    expect(servicesLines(noFacts({ services: [{ role: 'answer', task: '#5', tree: null, step: 'answer abcdef1' }, { role: 'implementer', task: '#6', tree: '/t', step: 'started' }] }), PLAIN_LORE)).toEqual([
      'answer · #5 · — · answer abcdef1',
      'implementer · #6 · /t · started',
    ])
  })

  it('the services screen shows the latest check matrix of each PR: its counts at its head, or why it was a full run', () => {
    const facts = noFacts({ matrices: [
      { pr: 921, head: null, full: 'the change touches the harness', killed: 0, survived: 0, notRun: 0 },
      { pr: 922, head: 'abcdef1234567890abcdef1234567890abcdef12', full: null, killed: 3, survived: 1, notRun: 2 },
    ] })
    expect(matrixLines(facts, PLAIN_LORE)).toEqual([
      'matrix · PR #921 · — · full run: the change touches the harness',
      'matrix · PR #922 · — · killed 3 · survived 1 · not run 2 @ abcdef1',
    ])
    expect(screenLines(facts, PLAIN_LORE).slice(-3, -1)).toEqual(matrixLines(facts, PLAIN_LORE))
    expect(matrixLines(noFacts(), PLAIN_LORE)).toEqual([])
  })

  it('the screen opens with the goal and shows the pulse and the slots in use', () => {
    const facts = noFacts({ goal: { release: '0.44', done: 3, total: 12 }, pulse: '2026-10-02T11:58:00.000Z', slots: [{ queue: 'review', used: 2 }] })
    expect(screenLines(facts, PLAIN_LORE)[0]).toBe('goal · release 0.44 · — · 3 of 12 done')
    expect(pulseLines(facts, PLAIN_LORE)).toEqual(['bus · pulse · — · pulse 2 min ago · slots in use: review 2 (the bus records no capacity)'])
    expect(pulseLines(noFacts(), PLAIN_LORE)).toEqual(['bus · pulse · — · no pulse recorded · slots in use: none in use (the bus records no capacity)'])
    expect(screenLines(noFacts(), PLAIN_LORE)[0]).toBe('Flow')
  })

  it('the footer names the agents at work, the last failure and the review queue', () => {
    const lines = screenLines(noFacts({ failure: 'card #8 fell at 2026-10-02T11:00:00.000Z', reviewQueue: 3, services: [{ role: 'merge', task: '#1', tree: null, step: 'merge' }] }), PLAIN_LORE)
    expect(lines.at(-1)).toBe('agents at work: 1 · last failure: card #8 fell at 2026-10-02T11:00:00.000Z · review queue: 3 · geek mode: --geek')
    expect(screenLines(noFacts(), PLAIN_LORE).at(-1)).toBe('agents at work: 0 · last failure: none · review queue: 0 · geek mode: --geek')
  })

  it('the lore and plain screens say the same', () => {
    const facts = noFacts({ cards: [card(1, 'queued', 'a')], failure: 'card #1 fell' })
    expect(screenLines(facts, LORE)).toEqual(screenLines(facts, PLAIN_LORE))
  })
})

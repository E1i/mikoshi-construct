import type { BusCard, BusFacts, CardStage, PlanStage } from '../../src/commands/board/bus.js'
import { describe, expect, it } from 'vitest'
import { backlogCards, backlogLines, boardScreens, flowLines, goalLines, matrixLines, pulseLines, screenLines, servicesLines } from '../../src/commands/board/screens.js'
import { LORE, PLAIN_LORE } from '../../src/ui/lore.js'

function card(id: number, state: string | null, lane: string | null = null, line: string | null = null, stage: CardStage = 'planned'): BusCard {
  return { id, state, stage, lane, line, since: null, body: true, closed: false, closedAt: null }
}

function noFacts(overrides: Partial<BusFacts> = {}): BusFacts {
  return { at: '2026-10-02T12:00:00.000Z', goal: null, plan: null, waits: [], pulse: null, slots: [], cards: [], services: [], matrices: [], failure: null, reviewQueue: 0, ...overrides }
}

describe('the board screens', () => {
  it('the board opens with the goal line, release and merged of total, and has none when the bus holds no goal', () => {
    const goal = { release: '0.44', done: 2, total: 3 }
    expect(goalLines(noFacts({ goal }), PLAIN_LORE)).toEqual(['goal · release 0.44 · — · merged 2/3'])
    expect(screenLines(noFacts({ goal }), PLAIN_LORE).slice(0, 3)).toEqual(['Flow', 'goal · release 0.44 · — · merged 2/3', 'planned (0): —'])
    expect(screenLines(noFacts(), PLAIN_LORE).slice(0, 2)).toEqual(['Flow', 'planned (0): —'])
  })

  it('the text board prints the goal line, the stages and waits for you only when not empty', () => {
    const goal = { release: '0.44', done: 2, total: 7 }
    const stages: [CardStage, number[]][] = [['planned', [5]], ['in work', [6, 7]], ['review', [8]], ['answer/changes', [9]], ['ready', []], ['merged', [1, 2]], ['stopped', [10]], ['dropped', [11]]]
    const plan: PlanStage[] = stages.map(([stage, cards]) => ({ stage, cards }))
    const waits = [
      { kind: 'question' as const, card: 10, pr: null, detail: 'which path?', since: null },
      { kind: 'version' as const, card: null, pr: 669, detail: null, since: null },
    ]
    const goalLine = 'goal · release 0.44 · — · merged 2/7 · planned 1 · in work 2 · review 1 · answer 1 · ready 0 · stopped 1'
    expect(screenLines(noFacts({ goal, plan, waits }), PLAIN_LORE).slice(0, 3)).toEqual(['Flow', goalLine, 'waits for you · 2 · — · question #10 (which path?) · version PR #669'])
    expect(screenLines(noFacts({ goal, plan }), PLAIN_LORE).slice(0, 3)).toEqual(['Flow', goalLine, 'planned (0): —'])
    const backlog = [card(8, 'in_review', null, '#8 eight', 'review'), card(9, 'in_review', null, '#9 nine', 'answer/changes'), card(4, 'running', null, '#4 four', 'ready')]
    expect(backlogLines(backlog, PLAIN_LORE)).toEqual(['no lane (3)', '  #8 eight · review', '  #9 nine · answer/changes', '  #4 four · ready'])
  })

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
    const cards = [card(1, 'queued', 'b', 'card: #1 alpha'), card(2, null, null, null), card(3, 'merged', 'a', '#3 gamma', 'merged'), card(4, 'stopped', 'b', 'card:#4 delta', 'stopped')]
    expect(backlogLines(cards, PLAIN_LORE)).toEqual([
      'a (1)',
      '  #3 gamma · merged',
      'b (2)',
      '  #1 alpha · planned',
      '  #4 delta · stopped',
      'no lane (1)',
      '  #2 · planned',
    ])
    expect(backlogLines([card(1, 'queued', 'a', 'card: #1 alpha')], PLAIN_LORE)).toEqual(['a (1)', '  #1 alpha · planned'])
  })

  it('backlog keeps a card closed less than 12 hours ago even when its cards row still reads a live state, and hides one closed earlier', () => {
    const closedAt = (hoursAgo: number): string => new Date(Date.parse('2026-10-02T12:00:00.000Z') - hoursAgo * 3_600_000).toISOString()
    const cards = [
      { ...card(1, 'running', null, '#1 fresh'), closed: true, closedAt: closedAt(1), since: closedAt(30) },
      { ...card(2, 'in_review', null, '#2 old'), closed: true, closedAt: closedAt(13), since: closedAt(30) },
    ]
    expect(backlogCards(cards, '2026-10-02T12:00:00.000Z', false).map(c => c.id)).toEqual([1])
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

  it('the board is three screens, Flow, Backlog and Services, and a footer, and its lines are those screens in order', () => {
    const facts = noFacts({ cards: [card(1, 'queued', 'a')], pulse: '2026-10-02T11:58:00.000Z' })
    const { screens, footer } = boardScreens(facts, PLAIN_LORE)
    expect(screens.map(screen => screen.title)).toEqual(['Flow', 'Backlog', 'Services'])
    expect(screens[2]!.lines).toEqual([...servicesLines(facts, PLAIN_LORE), ...pulseLines(facts, PLAIN_LORE)])
    expect(screenLines(facts, PLAIN_LORE)).toEqual([...screens.flatMap(screen => [screen.title, ...screen.lines]), footer])
  })

  it('the screen opens with Flow and shows the pulse and the slots in use', () => {
    const facts = noFacts({ pulse: '2026-10-02T11:58:00.000Z', slots: [{ queue: 'review', used: 2 }] })
    expect(screenLines(facts, PLAIN_LORE)[0]).toBe('Flow')
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

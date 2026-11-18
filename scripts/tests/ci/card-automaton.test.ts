import type { CardAutomaton, CardMover } from '../../ci/card-automaton.js'
import { describe, expect, it } from 'vitest'
import { automatonFindings, moversOf, unmovedConditions } from '../../ci/card-automaton.js'
import * as cards from '../../core/card-automaton.js'
import { cardAutomaton, queueMovers, queueSources } from '../../supervisor/composition.js'

const SYNTHETIC: CardAutomaton = {
  states: ['queued', 'running', 'limbo', 'closed'],
  ends: ['closed'],
  conditions: [{ state: 'queued', condition: 'admitted' }, { state: 'running', condition: 'session live' }, { state: 'limbo', condition: 'nobody looks' }],
}

const SYNTHETIC_MOVERS: CardMover[] = [{ node: 'launch', selects: [{ state: 'queued', condition: 'admitted' }, { state: 'running', condition: 'session live' }] }]

function cardStatesOfTheAutomaton(): string[] {
  return Object.entries(cards).filter(([name, value]) => name.endsWith('_CARD') && typeof value === 'string').map(([, value]) => value as string)
}

describe('the automaton check fails on a synthetic state no node selects', () => {
  it('a reachable condition no mover selects is a dead end', () => {
    expect(unmovedConditions(SYNTHETIC, SYNTHETIC_MOVERS).map(each => `${each.state}/${each.condition}`)).toEqual(['limbo/nobody looks'])
    expect(automatonFindings(SYNTHETIC, SYNTHETIC_MOVERS)).toEqual([`dead end limbo/nobody looks: no node's queue candidates select a limbo card on nobody looks`])
  })

  it('a state in work with no condition at all fails the check', () => {
    const silent = { ...SYNTHETIC, states: [...SYNTHETIC.states, 'void'] }
    expect(automatonFindings(silent, [...SYNTHETIC_MOVERS, { node: 'limbo', selects: [{ state: 'limbo', condition: 'nobody looks' }] }])).toEqual(['card state void is reachable and names no condition, so no node can be shown to select it'])
  })

  it('a mover that selects no condition of the automaton fails the check', () => {
    const stray = [...SYNTHETIC_MOVERS, { node: 'ghost', selects: [{ state: 'limbo', condition: 'nobody looks' }, { state: 'queued', condition: 'forgotten' }] }]
    expect(automatonFindings(SYNTHETIC, stray)).toEqual(['ghost selects queued/forgotten, which is no condition of the card automaton'])
  })

  it('an end state needs no mover', () => {
    expect(automatonFindings({ ...SYNTHETIC, conditions: [...SYNTHETIC.conditions, { state: 'closed', condition: 'merged and closed' }] }, [...SYNTHETIC_MOVERS, { node: 'x', selects: [{ state: 'limbo', condition: 'nobody looks' }] }])).toEqual([])
  })
})

describe('every reachable card state on main has a mover', () => {
  it('the composed automaton names every state the card folds can reach', () => {
    expect([...cardAutomaton().states].sort()).toEqual(cardStatesOfTheAutomaton().sort())
  })

  it('every condition of every state in work is selected by some node\'s queue candidates', () => {
    expect(automatonFindings(cardAutomaton(), queueMovers())).toEqual([])
  })

  it('the queue sources deriveQueues runs are the sources of the movers, in their order', () => {
    const sourced = queueMovers().flatMap(mover => mover.source === undefined ? [] : [mover.source])
    expect(queueSources()).toHaveLength(sourced.length)
    expect(sourced.length).toBeGreaterThan(0)
  })

  it('a stopped card on an owner question names the owner and the answer node as its movers', () => {
    expect(moversOf(queueMovers(), 'stopped')).toEqual(expect.arrayContaining(['answer', 'owner', 'restart', 'window']))
  })
})

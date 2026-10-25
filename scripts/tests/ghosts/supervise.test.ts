import { describe, expect, it } from 'vitest'
import { cardFellEvent, fallEvent, resultPathOf, sessionParams, supervisorSpawnOptions } from '../../ladder/supervise.js'

describe('supervisorSpawnOptions', () => {
  it('w2: starts the supervisor in a process group of its own, with no stdin from the window', () => {
    const options = supervisorSpawnOptions(7)
    expect(options.detached).toBe(true)
    expect(options.stdio).toEqual(['ignore', 7, 7])
  })
})

describe('resultPathOf', () => {
  it('puts the result beside the payload', () => {
    expect(resultPathOf('/out/ghost-launch-x.json')).toBe('/out/ghost-launch-x.result.json')
  })
})

describe('sessionParams', () => {
  it('a Ghost session sees its card in CONSTRUCT_CARD', () => {
    const params = sessionParams({ worktree: '/w', sessionId: 's', approvedText: 'p', reportPath: '/r', stderrPath: '/e', card: { id: 641 } } as never)
    expect(params.env?.CONSTRUCT_CARD).toBe('641')
  })
})

describe('cardFellEvent', () => {
  it('carries the journal fall line\'s card, kind and ts, written by the ladder of its session', () => {
    const ts = '2026-10-12T17:00:00.000Z'
    expect(fallEvent(890, 'ladder-not-done', ts)).toEqual({ event: 'fall', card: 890, kind: 'ladder-not-done', ts })
    expect(cardFellEvent(890, 'ladder-not-done', ts, 's1')).toMatchObject({ ts, type: 'card.fell', actor: 'worker:ladder:s1', cardId: 890, payload: { kind: 'ladder-not-done' }, legacy: false })
  })
})

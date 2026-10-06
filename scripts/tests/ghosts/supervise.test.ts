import { describe, expect, it } from 'vitest'
import { resultPathOf, sessionParams, supervisorSpawnOptions } from '../../ghosts/supervise.js'

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

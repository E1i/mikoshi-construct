import { describe, expect, it } from 'vitest'
import { formatCheapExpect } from '../../ghosts/cheap-expect.js'
import { formatExpect } from '../../ghosts/expect.js'

describe('the cheap EXPECT line', () => {
  it('prints the median tokens in words of their unit and minutes of the class with n, in the ladder\'s form with the class where the ladder names the effort', () => {
    expect(formatCheapExpect({ kind: 'forecast', taskClass: 'implement/XS', n: 8, tokens: 68_352, minutes: 4.4105 })).toBe('expect tokens ≈ 68k (input, cache writes and output; cache reads left out), minutes ≈ 4.4 — class implement/XS, n=8, median')
  })

  it('prints none with n and the class below five, through the ladder\'s formatExpect', () => {
    expect(formatCheapExpect({ kind: 'none', taskClass: 'probe/S', n: 2 })).toBe('expect none — n=2 for probe/S')
  })

  it('leaves the ladder\'s launch forecast as it was', () => {
    expect(formatExpect({ kind: 'forecast', tokens: 166_000, minutes: 12, basis: { effort: 'medium', n: 61 } })).toBe('expect tokens ≈ 166k, minutes ≈ 12 — effort medium, n=61, median')
  })
})

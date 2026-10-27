import { describe, expect, it } from 'vitest'
import { firstTickBound } from './first-tick-bound.js'

describe('the first tick bound', () => {
  const usual = [11.7, 11.7, 11.7]

  it('admits a first tick of twice a 11.7 ms median', () => {
    expect(23.4).toBeLessThanOrEqual(firstTickBound(usual))
  })

  it('refuses a first tick of 40 ms against a 11.7 ms median', () => {
    expect(40).toBeGreaterThan(firstTickBound(usual))
  })

  it('allows the slack over a median below the slack', () => {
    expect(firstTickBound([1, 1, 1])).toBe(6)
  })
})

import { describe, expect, it } from 'vitest'
import { median, MINIMUM_SAMPLE } from '../src/commands/cost/index.js'
import { quantile, RECENT_RUNS, recentBand } from '../src/commands/cost/sample.js'

describe('the forecast sample', () => {
  it('takes the middle value of an odd sample and the mean of the two middle values of an even one, whatever the order', () => {
    expect(median([9, 1, 5])).toBe(5)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('forecasts from five finished runs and no fewer', () => {
    expect(MINIMUM_SAMPLE).toBe(5)
  })
})

describe('the recent band', () => {
  it('interpolates p25 and p75 between ranks', () => {
    expect([quantile([10, 20, 30, 40, 50, 60], 0.25), quantile([10, 20, 30, 40, 50, 60], 0.75)]).toEqual([22.5, 47.5])
  })

  it('keeps the last twenty values of an oldest-first list', () => {
    const values: number[] = [...Array.from<number>({ length: 25 }).fill(1), ...Array.from<number>({ length: 20 }).fill(9)]
    expect(RECENT_RUNS).toBe(20)
    expect(recentBand(values)).toEqual({ kind: 'band', median: 9, p25: 9, p75: 9, n: 20 })
  })

  it('is none with n below five', () => {
    expect(recentBand([1, 2, 3, 4])).toEqual({ kind: 'none', n: 4 })
  })
})

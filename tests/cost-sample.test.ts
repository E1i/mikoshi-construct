import { describe, expect, it } from 'vitest'
import { median, MINIMUM_SAMPLE } from '../src/commands/cost/index.js'

describe('the forecast sample', () => {
  it('takes the middle value of an odd sample and the mean of the two middle values of an even one, whatever the order', () => {
    expect(median([9, 1, 5])).toBe(5)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('forecasts from five finished runs and no fewer', () => {
    expect(MINIMUM_SAMPLE).toBe(5)
  })
})

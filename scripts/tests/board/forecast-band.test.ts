import type { AttemptView } from '../../board/derive.js'
import { describe, expect, it } from 'vitest'
import { forecastOf } from '../../board/forecast.js'

function view(tokens: number, band?: { p25: number, p75: number }): AttemptView {
  const expected = { kind: 'forecast', tokens: 200_000, minutes: 10, basis: { effort: 'medium', n: 20 }, ...(band === undefined ? {} : { band }) }
  return { attempt: { taskEvent: { expected, actual: { tokens, minutes: 12 } } } } as unknown as AttemptView
}

describe('the actual beside the expected band', () => {
  it('w6: marks an actual above p75 as above band, below p25 as below band, between as in band', () => {
    const band = { p25: 150_000, p75: 250_000 }
    expect(forecastOf(view(300_000, band)).actual).toBe('tokens 300k · above band 150k–250k, minutes 12')
    expect(forecastOf(view(100_000, band)).actual).toBe('tokens 100k · below band 150k–250k, minutes 12')
    expect(forecastOf(view(250_000, band)).actual).toBe('tokens 250k · in band 150k–250k, minutes 12')
  })

  it('adds no mark for an expect recorded before the band', () => {
    expect(forecastOf(view(300_000)).actual).toBe('tokens 300k, minutes 12')
  })
})

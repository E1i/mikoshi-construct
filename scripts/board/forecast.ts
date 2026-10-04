import type { TokenBand } from '../ghosts/expect.js'
import type { AttemptView } from './derive.js'
import { formatTokens } from '../ghosts/expect-sample.js'
import { formatExpect } from '../ghosts/expect.js'

export interface Forecast {
  expect: string
  actual: string
}

export type ForecastOf = (view: AttemptView) => Forecast

function bandMark(tokens: number, band: TokenBand | undefined): string {
  if (band === undefined)
    return ''
  const range = `${formatTokens(band.p25)}–${formatTokens(band.p75)}`
  if (tokens > band.p75)
    return ` · above band ${range}`
  if (tokens < band.p25)
    return ` · below band ${range}`
  return ` · in band ${range}`
}

function actualText(view: AttemptView): string {
  const actual = view.attempt.taskEvent?.actual
  if (actual == null)
    return 'actual not recorded in the journal'
  const expected = view.attempt.taskEvent?.expected
  const band = expected?.kind === 'forecast' ? expected.band : undefined
  const tokens = actual.tokens === 'unknown' ? 'unknown' : `${formatTokens(actual.tokens)}${bandMark(actual.tokens, band)}`
  return `tokens ${tokens}, minutes ${Math.round(actual.minutes * 10) / 10}`
}

export function forecastOf(view: AttemptView): Forecast {
  const expected = view.attempt.taskEvent?.expected ?? null
  return { expect: expected === null ? 'expect not recorded in the journal' : formatExpect(expected), actual: actualText(view) }
}

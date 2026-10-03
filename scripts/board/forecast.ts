import type { AttemptView } from './derive.js'
import { formatTokens } from '../ghosts/expect-sample.js'
import { formatExpect } from '../ghosts/expect.js'

export interface Forecast {
  expect: string
  actual: string
}

export type ForecastOf = (view: AttemptView) => Forecast

function actualText(view: AttemptView): string {
  const actual = view.attempt.taskEvent?.actual
  if (actual == null)
    return 'actual not recorded in the journal'
  const tokens = actual.tokens === 'unknown' ? 'unknown' : formatTokens(actual.tokens)
  return `tokens ${tokens}, minutes ${Math.round(actual.minutes * 10) / 10}`
}

export function forecastOf(view: AttemptView): Forecast {
  const expected = view.attempt.taskEvent?.expected ?? null
  return { expect: expected === null ? 'expect not recorded in the journal' : formatExpect(expected), actual: actualText(view) }
}

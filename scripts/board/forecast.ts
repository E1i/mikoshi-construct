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
    return '—'
  const tokens = actual.tokens === 'unknown' ? 'unknown' : formatTokens(actual.tokens)
  return `tokens ${tokens}, minutes ${Math.round(actual.minutes * 10) / 10}`
}

export function forecastOf(view: AttemptView): Forecast {
  return { expect: formatExpect(view.attempt.taskEvent?.expected ?? null), actual: actualText(view) }
}

import type { CheapForecast } from '../../src/commands/cost/index.js'
import { cheapForecastOf } from '../../src/commands/cost/index.js'
import { formatTokens } from './expect-sample.js'
import { formatExpect } from './expect.js'

const UNIT = 'input, cache writes and output; cache reads left out'

function tenths(value: number): number {
  return Math.round(value * 10) / 10
}

export function formatCheapExpect(forecast: CheapForecast): string {
  if (forecast.kind === 'none')
    return formatExpect({ kind: 'none', reason: `n=${forecast.n} for ${forecast.taskClass}` })
  return `expect tokens ≈ ${formatTokens(forecast.tokens)} (${UNIT}), minutes ≈ ${tenths(forecast.minutes)} — class ${forecast.taskClass}, n=${forecast.n}, median`
}

export function cheapExpect(shiftRoot: string, windowJournal: string, taskClass: string, projectsDir: string): string {
  return formatCheapExpect(cheapForecastOf(shiftRoot, windowJournal, taskClass, projectsDir))
}

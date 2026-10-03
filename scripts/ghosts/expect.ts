import type { StepExpect } from './expect-sample.js'
import { formatStepExpect, formatTokens } from './expect-sample.js'

export type Expect
  = | { kind: 'forecast', tokens: number, minutes: number, basis: { effort: Effort, n: number } }
    | { kind: 'none', reason: string }

type Effort = 'low' | 'medium' | 'high'

const EXPECT_LINE_INDEX = 2
const EXPECT_PREFIX = 'expect: '
const LOOKS_LIKE_EXPECT = /^\s*expect:/i
const MINIMUM_SAMPLE = 5
const FORECAST = /^tokens ≈ (\d+(?:\.\d+)?)([kM]?), minutes ≈ (\d+(?:\.\d+)?) — effort (low|medium|high), n=(\d+), median$/
const NONE_AND_REASON = /^none — (\S.*)$/
const EFFORT_LINE = /^Effort: (\S+)/m
const TOKEN_SCALE: Record<string, number> = { '': 1, 'k': 1_000, 'M': 1_000_000 }

export function parseExpect(implementText: string): Expect | null {
  const lines = implementText.split('\n')
  const misplaced = lines.findIndex((line, index) => index !== EXPECT_LINE_INDEX && LOOKS_LIKE_EXPECT.test(line))
  if (misplaced !== -1)
    throw new Error(`an expect: line may stand only on line ${EXPECT_LINE_INDEX + 1} of the /implement text, and line ${misplaced + 1} is ${JSON.stringify(lines[misplaced])}`)

  const line = lines[EXPECT_LINE_INDEX]
  if (line === undefined || !LOOKS_LIKE_EXPECT.test(line))
    return null
  if (!line.startsWith(EXPECT_PREFIX))
    throw malformed(line)

  const value = line.slice(EXPECT_PREFIX.length)
  const forecast = FORECAST.exec(value)
  if (forecast !== null) {
    const n = Number(forecast[5])
    if (n < MINIMUM_SAMPLE)
      throw new Error(`the expect: line forecasts from n=${n}, below ${MINIMUM_SAMPLE}; write 'expect: none — <reason>' instead (${JSON.stringify(line)})`)
    return {
      kind: 'forecast',
      tokens: Math.round(Number(forecast[1]) * TOKEN_SCALE[forecast[2]]),
      minutes: Number(forecast[3]),
      basis: { effort: forecast[4] as Effort, n },
    }
  }

  const none = NONE_AND_REASON.exec(value)
  if (none !== null)
    return { kind: 'none', reason: none[1] }

  throw malformed(line)
}

export function briefEffort(implementText: string): string | null {
  return EFFORT_LINE.exec(implementText)?.[1] ?? null
}

function formatOverall(expected: Expect | null): string {
  if (expected === null)
    return 'expect —'
  if (expected.kind === 'none')
    return `expect none — ${expected.reason}`
  return `expect tokens ≈ ${formatTokens(expected.tokens)}, minutes ≈ ${expected.minutes} — effort ${expected.basis.effort}, n=${expected.basis.n}, median`
}

export function formatExpect(expected: Expect | null, steps: readonly StepExpect[] = []): string {
  const overall = formatOverall(expected)
  if (steps.length === 0)
    return overall
  return `${overall}; by step (effort ${steps[0].effort}, median): ${steps.map(formatStepExpect).join('; ')}`
}

function malformed(line: string): Error {
  return new Error(`the expect: line is neither 'tokens ≈ <num>[k|M], minutes ≈ <num> — effort <low|medium|high>, n=<int>, median' nor 'none — <reason>' (${JSON.stringify(line)})`)
}

import { describe, expect, it } from 'vitest'
import { briefEffort, formatExpect, formatStepBreakdown, parseExpect } from '../../ghosts/expect.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const DASH = String.fromCharCode(8212)
const APPROX = String.fromCharCode(8776)
const HEAD = `/implement x\nSketch: sketch/t @ ${SHA}`

function forecastLine(n: number): string {
  return `expect: tokens ${APPROX} 166k, minutes ${APPROX} 12 ${DASH} effort medium, n=${n}, median`
}

describe('parseExpect', () => {
  it('reads a forecast from line 3', () => {
    expect(parseExpect(`${HEAD}\n${forecastLine(61)}\n\nEffort: medium`)).toEqual({ kind: 'forecast', tokens: 166_000, minutes: 12, basis: { effort: 'medium', n: 61 } })
  })

  it('scales M and keeps fractional minutes', () => {
    expect(parseExpect(`${HEAD}\nexpect: tokens ${APPROX} 1.2M, minutes ${APPROX} 7.5 ${DASH} effort high, n=5, median`)).toEqual({ kind: 'forecast', tokens: 1_200_000, minutes: 7.5, basis: { effort: 'high', n: 5 } })
  })

  it('reads none and its reason', () => {
    expect(parseExpect(`${HEAD}\nexpect: none ${DASH} n=3 for effort high\n`)).toEqual({ kind: 'none', reason: 'n=3 for effort high' })
  })

  it('returns null when no expect: line is written', () => {
    expect(parseExpect(`${HEAD}\n\nEffort: low`)).toBeNull()
    expect(parseExpect(HEAD)).toBeNull()
  })

  it('refuses a forecast from a sample below five', () => {
    expect(() => parseExpect(`${HEAD}\n${forecastLine(4)}`)).toThrow('n=4, below 5')
  })

  it('refuses a malformed expect: line, quoting it', () => {
    for (const line of [
      'expect: tokens 166k',
      `expect: tokens ${APPROX} 166k, minutes ${APPROX} 12 ${DASH} effort medium, n=61`,
      `expect: tokens ${APPROX} 166k, minutes ${APPROX} 12 ${DASH} effort huge, n=61, median`,
      'expect: none',
      `expect: none ${DASH} `,
      'expect: none - reason',
      `Expect: none ${DASH} capitalised`,
      ` expect: none ${DASH} indented`,
    ]) {
      expect(() => parseExpect(`${HEAD}\n${line}`)).toThrow(JSON.stringify(line))
    }
  })

  it('refuses an expect: line on any line but 3, naming its line number', () => {
    expect(() => parseExpect(`/implement x\n${forecastLine(61)}`)).toThrow('line 2 is')
    expect(() => parseExpect(`${HEAD}\n\n\n  EXPECT: none ${DASH} late`)).toThrow('line 5 is')
    expect(() => parseExpect(`${HEAD}\n${forecastLine(61)}\n${forecastLine(61)}`)).toThrow('line 4 is')
  })
})

describe('formatExpect', () => {
  it('renders a forecast in the form of the brief, tokens through formatTokens', () => {
    expect(formatExpect({ kind: 'forecast', tokens: 166_000, minutes: 7.8, basis: { effort: 'medium', n: 61 } })).toBe(`expect tokens ${APPROX} 166k, minutes ${APPROX} 7.8 ${DASH} effort medium, n=61, median`)
  })

  it('renders none with its reason', () => {
    expect(formatExpect({ kind: 'none', reason: 'n=3 for effort low' })).toBe(`expect none ${DASH} n=3 for effort low`)
  })

  it('renders a dash when the brief has no expect: line', () => {
    expect(formatExpect(null)).toBe(`expect ${DASH}`)
  })
})

describe('briefEffort', () => {
  it('takes the first word on the Effort: line', () => {
    expect(briefEffort(`${HEAD}\n\nEffort: medium ${DASH} reason`)).toBe('medium')
    expect(briefEffort(`${HEAD}\n\nEffort: high.`)).toBe('high')
  })

  it('returns null without an Effort: line or when only a newline follows it', () => {
    expect(briefEffort(HEAD)).toBeNull()
    expect(briefEffort(`${HEAD}\nEffort:\nmedium`)).toBeNull()
  })
})

describe('formatStepBreakdown', () => {
  const steps = [{ kind: 'forecast', step: 'implement', effort: 'medium', tokens: 100_000, p25: 80_000, p75: 120_000, minutes: 5, n: 5 } as const]

  it('is empty for no steps', () => {
    expect(formatStepBreakdown([])).toBe('')
  })

  it('is what formatExpect appends to the overall text', () => {
    const expected = { kind: 'none', reason: 'why' } as const
    expect(formatExpect(expected, steps)).toBe(`${formatExpect(expected)}${formatStepBreakdown(steps)}`)
    expect(formatStepBreakdown(steps)).toMatch(/^; by step \(effort medium, median\): implement /)
  })
})

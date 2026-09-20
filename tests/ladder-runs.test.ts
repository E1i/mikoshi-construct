import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, 'fixtures/ladder-runs')
const SMALLEST_REFUSED_PAYLOAD = 3436

interface Attempt {
  outcome: 'unparsable' | 'empty' | 'accepted'
  journaledChars: number
}

interface LadderRun {
  run: string
  returnedADesign: boolean
  everyValueIsAPlaceholder: boolean
  acceptedBytes: number | null
  attempts: Attempt[]
  accepted: Record<string, string | string[]> | null
  brief: string | null
}

function runs(): LadderRun[] {
  return readdirSync(ROOT)
    .filter(entry => entry.endsWith('.json'))
    .sort()
    .map(entry => JSON.parse(readFileSync(path.join(ROOT, entry), 'utf8')) as LadderRun)
}

function valuesOf(run: LadderRun): string[] {
  return Object.values(run.accepted ?? {}).flatMap(field => typeof field === 'string' ? [field] : field)
}

describe('what this repository\'s own design step returned', () => {
  it('records every architect entry the runs produced', () => {
    expect(runs()).toHaveLength(9)
  })

  it('counts three real designs, two placeholders and four that returned nothing', () => {
    const outcome = (run: LadderRun): string => !run.returnedADesign
      ? 'nothing'
      : run.everyValueIsAPlaceholder ? 'placeholder' : 'design'
    const counted = runs().reduce<Record<string, number>>((tally, run) => ({ ...tally, [outcome(run)]: (tally[outcome(run)] ?? 0) + 1 }), {})
    expect(counted).toEqual({ design: 3, placeholder: 2, nothing: 4 })
  })

  it('accepted a design whose every value is a placeholder, twice', () => {
    for (const run of runs().filter(entry => entry.everyValueIsAPlaceholder)) {
      expect(valuesOf(run).every(value => value.length <= 6)).toBe(true)
      expect(run.attempts.at(-1)?.outcome).toBe('accepted')
    }
  })

  it('reached that placeholder only after attempts the runtime had already refused', () => {
    for (const run of runs().filter(entry => entry.everyValueIsAPlaceholder))
      expect(run.attempts.filter(attempt => attempt.outcome !== 'accepted').length).toBeGreaterThanOrEqual(3)
  })

  it('shows every real design is larger than the smallest payload known to be refused', () => {
    const real = runs().filter(run => run.returnedADesign && !run.everyValueIsAPlaceholder)
    expect(real).toHaveLength(3)
    for (const run of real)
      expect(run.acceptedBytes, `${run.run} was accepted`).toBeGreaterThan(SMALLEST_REFUSED_PAYLOAD)
  })

  it('accepted its largest design on the first attempt', () => {
    const largest = runs().reduce((best, run) => (run.acceptedBytes ?? 0) > (best.acceptedBytes ?? 0) ? run : best)
    expect(largest.acceptedBytes).toBeGreaterThan(SMALLEST_REFUSED_PAYLOAD * 4)
    expect(largest.attempts).toHaveLength(1)
  })

  it('holds no control character in any value a design was accepted with', () => {
    for (const run of runs())
      expect([...valuesOf(run).join('')].filter(character => character.codePointAt(0)! < 0x20)).toEqual([])
  })

  it('carries a brief for every run, to measure the design step against', () => {
    for (const run of runs()) {
      expect(run.brief?.startsWith('Task:'), `${run.run} keeps its brief`).toBe(true)
      expect(run.brief!.length).toBeGreaterThan(2000)
    }
  })
})

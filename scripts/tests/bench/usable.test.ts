import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIREMENTS, usability } from '../../bench/usable.js'

const RUNS = path.resolve(import.meta.dirname, '../../../tests/fixtures/ladder-runs')

interface LadderRun {
  run: string
  everyValueIsAPlaceholder: boolean
  accepted: Record<string, string | string[]> | null
}

function accepted(): LadderRun[] {
  return readdirSync(RUNS)
    .filter(entry => entry.endsWith('.json'))
    .sort()
    .map(entry => JSON.parse(readFileSync(path.join(RUNS, entry), 'utf8')) as LadderRun)
    .filter(run => run.accepted != null)
}

describe('a design is usable or it is not, judged against the runs that were recorded', () => {
  it('calls every real design usable', () => {
    const real = accepted().filter(run => !run.everyValueIsAPlaceholder)
    expect(real).toHaveLength(3)
    for (const run of real)
      expect(usability(run.accepted), `${run.run}`).toEqual({ usable: true, shortfalls: [] })
  })

  it('calls every placeholder the ladder accepted unusable, and names why', () => {
    const placeholders = accepted().filter(run => run.everyValueIsAPlaceholder)
    expect(placeholders).toHaveLength(2)
    for (const run of placeholders) {
      const verdict = usability(run.accepted)
      expect(verdict.usable, `${run.run}`).toBe(false)
      expect(verdict.shortfalls.join(' ')).toContain('decision is 4 characters')
    }
  })

  it('sets every requirement inside the gap, far from both sides of it', () => {
    const real = accepted().filter(run => !run.everyValueIsAPlaceholder).map(run => run.accepted!)
    const smallest = {
      decisionCharacters: Math.min(...real.map(design => (design.decision as string).length)),
      entryCharacters: Math.min(...real.flatMap(design => (design.acceptance as string[]).concat(design.constraints as string[]).map(entry => entry.length))),
      pathCharacters: Math.min(...real.flatMap(design => (design.files as string[]).map(entry => entry.length))),
      entries: Math.min(...real.map(design => (design.acceptance as string[]).length)),
    }
    for (const [requirement, value] of Object.entries(REQUIREMENTS))
      expect(smallest[requirement as keyof typeof smallest], `${requirement} leaves room above`).toBeGreaterThan(value)
  })

  it('refuses anything that is not a design at all', () => {
    expect(usability(null).usable).toBe(false)
    expect(usability([]).usable).toBe(false)
    expect(usability({}).shortfalls.length).toBeGreaterThan(3)
  })
})

import type { SliceSources } from '../../src/card/slice-depends.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cardLineOf, CHARACTERS_PER_TOKEN, EDDIES_FILE, readingBudget, START_TOKENS, volumeLines, volumeSignal } from '../../src/card/complexity.js'
import { SLICE_PREFIX } from '../../src/card/risk.js'

const REPOSITORY = path.resolve(import.meta.dirname, '../..')
const KILOBYTE = 1_000
const EDDIES = readFileSync(path.join(REPOSITORY, EDDIES_FILE), 'utf8')

function sourcesOf(sizes: Record<string, number>): SliceSources {
  return {
    read: relative => relative === EDDIES_FILE ? EDDIES : sizes[relative] === undefined ? null : 'x'.repeat(sizes[relative]),
    filesUnder: () => [],
  }
}

const TOUCHES = ['scripts/nodes/launch/launch-candidates.ts', 'scripts/nodes/launch/lane-assign.ts', 'scripts/cli/board-warnings.ts', 'scripts/tests/bus/launch-node.test.ts']

describe('the reading budget is a share of the context line of the card size', () => {
  it('an M card whose touches hold about 120 KB is told to raise its size to L or is proposed a cut', () => {
    const sources = sourcesOf({ [TOUCHES[0]!]: 40 * KILOBYTE, [TOUCHES[1]!]: 30 * KILOBYTE, [TOUCHES[2]!]: 20 * KILOBYTE, [TOUCHES[3]!]: 30 * KILOBYTE })
    const verdict = volumeSignal(TOUCHES, sources, 'M')

    expect(verdict.over).toBe(true)
    expect(verdict.raiseTo).toBe('L')
    expect(verdict.slices.length).toBeGreaterThan(1)
    const lines = volumeLines(verdict)
    expect(lines[0]).toContain('raise its size to L')
    expect(lines.filter(line => line.startsWith(SLICE_PREFIX)).length).toBe(verdict.slices.length)
  })

  it('the M budget is the M line less the start and a reasoning reserve, about 50–60k and not 100k', () => {
    const sources = sourcesOf({})
    const budget = readingBudget(cardLineOf('M', sources))

    expect(budget).toBeGreaterThanOrEqual(50_000)
    expect(budget).toBeLessThanOrEqual(60_000)
    expect(budget).toBeLessThan(cardLineOf('M', sources) - START_TOKENS)
  })

  it('the same reading fits an L card whole', () => {
    const sources = sourcesOf({ [TOUCHES[0]!]: 60 * KILOBYTE, [TOUCHES[1]!]: 60 * KILOBYTE })
    const verdict = volumeSignal(TOUCHES.slice(0, 2), sources, 'L')

    expect(verdict.over).toBe(false)
    expect(verdict.tokens).toBe(120 * KILOBYTE / CHARACTERS_PER_TOKEN)
  })

  it('an M card within its budget takes no volume seam', () => {
    const sources = sourcesOf({ [TOUCHES[0]!]: 50 * KILOBYTE })

    expect(volumeSignal(TOUCHES.slice(0, 1), sources, 'M').over).toBe(false)
  })
})

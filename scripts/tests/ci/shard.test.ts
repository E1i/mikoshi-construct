import type { TestWeights } from '../../ci/shard.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { balanceShards, weightOf, weightsFromVitestReport } from '../../ci/shard.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const committed = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/ci/test-weights.json'), 'utf8')) as TestWeights

const total = (files: string[], weights: TestWeights) => files.reduce((sum, file) => sum + weightOf(file, weights), 0)

describe('balanceShards', () => {
  it('puts every file in exactly one shard', () => {
    const files = Object.keys(committed)
    const shards = balanceShards(files, committed, 3)
    expect(shards.flat().sort()).toEqual([...files].sort())
  })

  it('gives every shard job the same split, whatever order vitest hands the files in', () => {
    const files = Object.keys(committed)
    expect(balanceShards([...files].reverse(), committed, 2)).toEqual(balanceShards(files, committed, 2))
  })

  it('separates the two heaviest files, which a split by path hash can put together', () => {
    const [first, second] = Object.entries(committed).sort(([, a], [, b]) => b - a).map(([file]) => file)
    const shards = balanceShards(Object.keys(committed), committed, 2)
    expect(shards.findIndex(shard => shard.includes(first!))).not.toBe(shards.findIndex(shard => shard.includes(second!)))
  })

  it('keeps the recorded shards within one heaviest file of each other', () => {
    const [a, b] = balanceShards(Object.keys(committed), committed, 2)
    const heaviest = Math.max(...Object.values(committed))
    expect(Math.abs(total(a!, committed) - total(b!, committed))).toBeLessThanOrEqual(heaviest)
  })

  it('weighs a file the table has not seen yet at the median, so a new test does not all land in one shard', () => {
    expect(weightOf('tests/new.test.ts', { 'a.test.ts': 1, 'b.test.ts': 5, 'c.test.ts': 40 })).toBe(5)
    expect(weightOf('tests/new.test.ts', {})).toBe(1)
  })
})

describe('weightsFromVitestReport', () => {
  it('records each file relative to the root, in seconds to one decimal, sorted by path', () => {
    const report = { testResults: [
      { name: '/repo/tests/b.test.ts', startTime: 1000, endTime: 3460 },
      { name: '/repo/tests/a.test.ts', startTime: 0, endTime: 120 },
    ] }
    expect(Object.entries(weightsFromVitestReport(report, '/repo'))).toEqual([['tests/a.test.ts', 0.1], ['tests/b.test.ts', 2.5]])
  })
})

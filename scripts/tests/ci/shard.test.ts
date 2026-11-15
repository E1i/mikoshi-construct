import type { TestWeights } from '../../ci/shard.js'
import type { RunJob } from '../../ci/test-weights.js'
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import config from '../../../vitest.config.js'
import { balanceShards, MIN_WEIGHT, NO_DATA_WEIGHT, updateWeights, weightOf, weightsFromFileWeights } from '../../ci/shard.js'
import { CI_SHARDS, comparableSpreads, compareSpreads, MAX_SHARD_IMBALANCE, MIN_RUNS_PER_SIDE, shardSpread, spreadLines, testSetOf } from '../../ci/test-weights.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const committed = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/ci/test-weights.json'), 'utf8')) as TestWeights
interface CiVitestJob { name: string, strategy: { matrix: { shard: number[] } }, steps: { run?: string }[] }
const ciVitestJob = (): CiVitestJob => (parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: { vitest: CiVitestJob } }).jobs.vitest

const total = (files: string[], weights: TestWeights) => files.reduce((sum, file) => sum + weightOf(file, weights), 0)
const fullTestSet = (): string[] => globSync(config.test!.include!, { cwd: REPO_ROOT, exclude: config.test!.exclude! }).sort()

describe('the shards CI runs', () => {
  it('the test ids over all weighted shards equal the full set with no duplicate', () => {
    const files = fullTestSet()
    expect(files.length).toBeGreaterThan(100)
    const assigned = balanceShards(files, committed, CI_SHARDS).flat()
    expect(assigned).toHaveLength(new Set(assigned).size)
    expect([...assigned].sort()).toEqual(files)
  })

  it('the shard count in ci.yml equals the shard count of the weights table', () => {
    const job = ciVitestJob()
    expect(CI_SHARDS).toBe(8)
    expect(job.strategy.matrix.shard).toEqual(Array.from({ length: CI_SHARDS }, (_, at) => at + 1))
    expect(job.name).toBe(`vitest \${{ matrix.shard }}/${CI_SHARDS}`)
    expect(job.steps.filter(step => step.run?.includes('--shard=')).map(step => /--shard=[^/]*\/(\d+)/.exec(step.run!)?.[1])).toEqual([String(CI_SHARDS)])
  })

  it('the committed weights split the full set into shards whose longest is within the allowed imbalance of the shortest', () => {
    const totals = balanceShards(fullTestSet(), committed, CI_SHARDS).map(shard => total(shard, committed))
    expect(Math.max(...totals)).toBeLessThanOrEqual(Math.min(...totals) * (1 + MAX_SHARD_IMBALANCE))
  })

  it('the committed table weighs no file at zero', () => {
    expect(Object.entries(committed).filter(([, weight]) => weight < MIN_WEIGHT)).toEqual([])
  })
})

describe('the test:weights contract', () => {
  it('test weights with no data and with a new test follow the written contract', () => {
    expect(weightOf('tests/a.test.ts', {})).toBe(NO_DATA_WEIGHT)
    const byCount = balanceShards(['a', 'b', 'c', 'd', 'e', 'f', 'g'], {}, 3).map(shard => shard.length)
    expect(Math.max(...byCount) - Math.min(...byCount)).toBeLessThanOrEqual(1)

    const measured = { 'a.test.ts': 0, 'b.test.ts': 0, 'c.test.ts': 0, 'd.test.ts': 30 }
    expect(weightOf('tests/new.test.ts', measured)).toBe(MIN_WEIGHT)
    expect(weightOf('a.test.ts', measured)).toBe(MIN_WEIGHT)
    const newTests = ['n1.test.ts', 'n2.test.ts', 'n3.test.ts', 'n4.test.ts', 'n5.test.ts', 'n6.test.ts']
    const shards = balanceShards([...Object.keys(measured), ...newTests], measured, 3)
    expect(shards.filter(shard => shard.some(file => newTests.includes(file))).length).toBeGreaterThan(1)

    const previous = { 'kept.test.ts': 4, 'remeasured.test.ts': 9, 'deleted.test.ts': 2 }
    const onDisk = new Set(['kept.test.ts', 'remeasured.test.ts', 'new.test.ts'])
    expect(updateWeights(previous, { 'remeasured.test.ts': 3, 'new.test.ts': 0.4 }, file => onDisk.has(file)))
      .toEqual({ 'kept.test.ts': 4, 'new.test.ts': 0.4, 'remeasured.test.ts': 3 })
  })

  it('puts a file listed twice in one shard once', () => {
    expect(balanceShards(['a', 'a', 'b'], {}, 2).flat().sort()).toEqual(['a', 'b'])
  })
})

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

describe('weightsFromFileWeights', () => {
  const inRepo = (...files: string[]) => (file: string): boolean => files.includes(file)

  it('keeps each measured file of this repository, sorted by path, never below the minimum weight', () => {
    const exists = inRepo('tests/a.test.ts', 'tests/b.test.ts', 'tests/fast.test.ts')
    const measured = weightsFromFileWeights({ 'tests/b.test.ts': 2.5, 'tests/fast.test.ts': 0, 'tests/a.test.ts': 9 }, exists)
    expect(Object.entries(measured)).toEqual([['tests/a.test.ts', 9], ['tests/b.test.ts', 2.5], ['tests/fast.test.ts', MIN_WEIGHT]])
    expect(updateWeights({}, measured, exists)).toEqual(measured)
  })

  it('measures nothing from a file no longer in this repository, or from a record that is not a weight table', () => {
    expect(weightsFromFileWeights({ 'tests/gone.test.ts': 4 }, inRepo('tests/a.test.ts'))).toEqual({})
    expect(weightsFromFileWeights({ 'tests/a.test.ts': 'slow' }, inRepo('tests/a.test.ts'))).toEqual({})
    expect(weightsFromFileWeights({ testResults: [] }, () => true)).toEqual({})
    expect(weightsFromFileWeights([], () => true)).toEqual({})
    expect(weightsFromFileWeights(null, () => true)).toEqual({})
  })
})

describe('the shard spread on main', () => {
  const at = (second: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString()
  const shardJob = (index: number, count: number, testSeconds: number, conclusion = 'success'): RunJob => ({
    name: `vitest ${index}/${count}`,
    conclusion,
    startedAt: at(0),
    completedAt: at(testSeconds + 30),
    steps: [{ name: 'Run pnpm install --frozen-lockfile', startedAt: at(0), completedAt: at(10) }, { name: `Run pnpm test --shard=${index}/${count}`, startedAt: at(10), completedAt: at(10 + testSeconds) }],
  })

  it('is the gap between the slowest and the fastest test step of one run', () => {
    expect(shardSpread([shardJob(1, 3, 50), shardJob(2, 3, 170), shardJob(3, 3, 80), { name: 'lint', conclusion: 'success', startedAt: at(0), completedAt: at(500) }])).toEqual({ shards: 3, spread: 120 })
  })

  it('is no reading when a shard failed or is missing', () => {
    expect(shardSpread([shardJob(1, 3, 50), shardJob(2, 3, 170, 'failure'), shardJob(3, 3, 80)])).toBeUndefined()
    expect(shardSpread([shardJob(1, 3, 50), shardJob(3, 3, 80)])).toBeUndefined()
    expect(shardSpread([])).toBeUndefined()
  })

  it('compares only runs on the boundary\'s test set and shard count, so a grown suite moves no gap', () => {
    const files = ['tests/a.test.ts', 'scripts/tests/b.test.ts', 'tests/fixtures/c.test.ts', 'src/d.ts']
    const testSet = testSetOf(files)
    expect(testSet).toBe('scripts/tests/b.test.ts\ntests/a.test.ts')
    const grown = testSetOf([...files, 'tests/new.test.ts'])
    const before = [{ testSet, shards: 4, spread: 100 }, { testSet: grown, shards: 4, spread: 10 }]
    const after = [{ testSet, shards: 4, spread: 40 }, { testSet, shards: 3, spread: 5 }, { testSet: grown, shards: 4, spread: 300 }]
    expect(comparableSpreads(before, after, testSet)).toEqual({ before: [100], after: [40], excluded: 3 })
  })

  it('with too few comparable runs on either side prints not proven yet, which is not green', () => {
    const verdict = compareSpreads([100, 110, 120], [40])
    expect(verdict.kind).toBe('not-proven')
    expect(spreadLines(verdict, 'a'.repeat(40)).at(-1)).toMatch(/^not proven yet: /)
    expect(compareSpreads([1, 2], [1, 2, 3], MIN_RUNS_PER_SIDE).kind).toBe('not-proven')
  })

  it('reads smaller only when the median gap after is below every gap before, so run-to-run noise is no win', () => {
    expect(compareSpreads([100, 110, 120], [40, 50, 200]).kind).toBe('smaller')
    expect(compareSpreads([124, 119, 125, 131, 141, 119], [128, 112, 141, 141, 117, 94]).kind).toBe('not-smaller')
    expect(compareSpreads([100, 110, 120], [110, 120, 130]).kind).toBe('not-smaller')
  })
})

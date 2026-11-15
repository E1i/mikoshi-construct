import type { TestWeights } from '../../ci/shard.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { updateWeights } from '../../ci/shard.js'
import { MAX_DRIFTED_SHARE, MAX_UNWEIGHTED_SHARE, MAX_WEIGHT_RATIO, WEIGHTS_PATH, weightsDrift, weightsFreshness } from '../../ci/test-weights.js'
import { pnpmCommand } from '../../core/owner-commands.js'
import { processGit } from '../../ports/git.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const committed = JSON.parse(readFileSync(path.join(REPO_ROOT, WEIGHTS_PATH), 'utf8')) as TestWeights
const trackedFiles = (): string[] => (processGit.readOrNull(REPO_ROOT, ['ls-files']) ?? '').split('\n').filter(file => file !== '')

describe('the shard weight table never goes stale silently', () => {
  const files = Array.from({ length: 20 }, (_, at) => `tests/t${String(at).padStart(2, '0')}.test.ts`)
  const weighted = (count: number): TestWeights => Object.fromEntries(files.slice(0, count).map(file => [file, 1]))

  it('a table that leaves more test files unweighted than the threshold is red and names the recompute command', () => {
    const verdict = weightsFreshness([...files, 'src/not-a-test.ts'], weighted(17))
    expect(verdict).toMatchObject({ tests: 20, stale: true })
    expect(verdict.unweighted).toEqual(files.slice(17))
    expect(verdict.line).toContain(pnpmCommand('test:weights', '--from', 'main'))
  })

  it('a table that leaves the threshold share or less unweighted is green', () => {
    expect(weightsFreshness(files, weighted(18)).stale).toBe(false)
    expect(weightsFreshness(files, weighted(20))).toMatchObject({ unweighted: [], stale: false })
  })

  it('the committed table weighs every test file but the threshold', () => {
    const verdict = weightsFreshness(trackedFiles(), committed)
    expect(verdict.tests).toBeGreaterThan(100)
    expect(verdict.unweighted.length / verdict.tests, verdict.line).toBeLessThanOrEqual(MAX_UNWEIGHTED_SHARE)
  })
})

describe('the shard weight table is fresh by measured time, not by file count', () => {
  const files = Array.from({ length: 16 }, (_, at) => `tests/t${String(at).padStart(2, '0')}.test.ts`)
  const measured: TestWeights = Object.fromEntries(files.map(file => [file, 10]))
  const table = (overrides: Record<string, number | undefined>): TestWeights => Object.fromEntries(Object.entries({ ...measured, ...overrides }).filter(([, weight]) => weight !== undefined)) as TestWeights

  it('drifted time above the share of the longest shard is red and names the recompute command', () => {
    const verdict = weightsDrift(measured, table({ [files[0]!]: 4 }))
    expect(verdict).toMatchObject({ drifted: [files[0]], driftedSeconds: 10, longestShardSeconds: 20, stale: true })
    expect(verdict.share).toBeGreaterThan(MAX_DRIFTED_SHARE)
    expect(verdict.line).toContain(pnpmCommand('test:weights', '--from', 'main'))

    const unweighted = weightsDrift(measured, table({ [files[0]!]: undefined }))
    expect(unweighted).toMatchObject({ drifted: [files[0]], stale: true })
    expect(unweighted.line).toContain(pnpmCommand('test:weights', '--from', 'main'))
  })

  it('a table recomputed from the same measurements is green', () => {
    const stale = table({ [files[0]!]: 4, [files[1]!]: undefined })
    const verdict = weightsDrift(measured, updateWeights(stale, measured, () => true))
    expect(verdict).toMatchObject({ drifted: [], driftedSeconds: 0, stale: false })
    expect(verdict.line).not.toContain(pnpmCommand('test:weights', '--from', 'main'))
  })

  it('a weight within the ratio of its measurement, or an unweighted file carrying little time, stays green', () => {
    expect(weightsDrift(measured, table({ [files[0]!]: 10 / MAX_WEIGHT_RATIO, [files[1]!]: 10 * MAX_WEIGHT_RATIO })).drifted).toEqual([])
    const light = weightsDrift({ ...measured, 'tests/light.test.ts': 0.5 }, measured)
    expect(light).toMatchObject({ drifted: ['tests/light.test.ts'], stale: false })
    expect(light.share).toBeLessThanOrEqual(MAX_DRIFTED_SHARE)
  })
})

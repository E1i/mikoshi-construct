import type { TestWeights } from '../../ci/shard.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FILE_WEIGHTS_NAME } from '../../ci/file-weights-reporter.js'
import { updateWeights } from '../../ci/shard.js'
import { MAX_DRIFTED_SHARE, MAX_UNWEIGHTED_SHARE, MAX_WEIGHT_RATIO, measurementAt, measurementFromRuns, WEIGHTS_PATH, weightsDrift, weightsFreshness } from '../../ci/test-weights.js'
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

describe('the shard weight table is measured by whole file, never by the JSON report', () => {
  const temporary: string[] = []
  afterEach(() => {
    for (const directory of temporary.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })
  const artifact = (files: Record<string, unknown>): string => {
    const directory = mkdtempSync(path.join(tmpdir(), 'vitest-report-'))
    temporary.push(directory)
    for (const [name, content] of Object.entries(files))
      writeFileSync(path.join(directory, name), JSON.stringify(content))
    return directory
  }
  const inRepo = (file: string): boolean => ['tests/heavy.test.ts', 'tests/light.test.ts'].includes(file)
  const jsonReport = { testResults: [
    { name: '/repo/tests/heavy.test.ts', status: 'passed', startTime: 0, endTime: 500 },
    { name: '/repo/tests/light.test.ts', status: 'passed', startTime: 0, endTime: 3000 },
  ] }
  const wholeFile = { 'tests/heavy.test.ts': 21, 'tests/light.test.ts': 3.2 }

  it('test:weights reads the whole-file measurement and never the JSON test span', () => {
    const both = artifact({ 'vitest.json': jsonReport, [FILE_WEIGHTS_NAME]: wholeFile })
    const measured = measurementAt(path.join(both, FILE_WEIGHTS_NAME), inRepo)
    expect(measured).toMatchObject({ kind: 'measured', weights: wholeFile })

    const onlyJson = artifact({ 'vitest.json': jsonReport })
    const absent = measurementAt(path.join(onlyJson, FILE_WEIGHTS_NAME), inRepo)
    expect(absent.kind).toBe('absent')
    expect(absent.kind === 'absent' && absent.line).toContain('left as it is')

    const runs = new Map([[3, onlyJson], [2, onlyJson], [1, both]])
    const fromMain = measurementFromRuns([4, 3, 2, 1], run => runs.get(run), inRepo)
    expect(fromMain).toEqual({ kind: 'measured', source: 'run 1', weights: wholeFile })

    const none = measurementFromRuns([3, 2], run => runs.get(run), inRepo)
    expect(none.kind).toBe('absent')
    expect(none.kind === 'absent' && none.line).toMatch(/2 carry only the JSON report.*left as it is/)

    if (measured.kind !== 'measured')
      throw new Error('the whole-file measurement was not read')
    const table = { 'tests/heavy.test.ts': 0.5, 'tests/light.test.ts': 3 }
    expect(weightsDrift(measured.weights, table).drifted).toEqual(['tests/heavy.test.ts'])
    expect(updateWeights(table, measured.weights, inRepo)).toEqual(wholeFile)
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

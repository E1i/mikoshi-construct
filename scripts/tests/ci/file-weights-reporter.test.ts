import type { TestModule, Vitest } from 'vitest/node'
import type { MeasuredModule, WholeFileTimings } from '../../ci/file-weights-reporter.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import FileWeightsReporter, { FILE_WEIGHTS_NAME, fileWeightsOf, jsonReportOf, wholeFileMilliseconds } from '../../ci/file-weights-reporter.js'
import { balanceShards, MIN_WEIGHT } from '../../ci/shard.js'
import { FILE_WEIGHTS_PATH, JSON_REPORT_PATH } from '../../ci/test-weights.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const REPORTER_REFERENCE = '--reporter=./scripts/ci/file-weights-reporter.ts'

const timings = (overrides: Partial<WholeFileTimings>): WholeFileTimings => ({ environmentSetupDuration: 0, prepareDuration: 0, setupDuration: 0, collectDuration: 0, duration: 0, ...overrides })
const passedModule = (file: string, overrides: Partial<WholeFileTimings>): MeasuredModule => ({ file, passed: true, timings: timings(overrides) })

describe('a file weight is its whole wall time in its shard', () => {
  const importHeavy = { environmentSetupDuration: 300, prepareDuration: 200, setupDuration: 1500, collectDuration: 4000, duration: 500 }

  it('a file weight counts its prepare, setup and collect time, not only its tests', () => {
    expect(wholeFileMilliseconds(timings(importHeavy))).toBe(6500)
    expect(fileWeightsOf([passedModule('tests/heavy.test.ts', importHeavy)])).toEqual({ 'tests/heavy.test.ts': 6.5 })
  })

  it('weighs only passed files, in seconds to one decimal, never below the minimum, sorted by path', () => {
    const weights = fileWeightsOf([
      passedModule('tests/b.test.ts', { collectDuration: 1200, duration: 1260 }),
      passedModule('tests/a.test.ts', { duration: 20 }),
      { file: 'tests/broke.test.ts', passed: false, timings: timings({ duration: 9000 }) },
    ])
    expect(Object.entries(weights)).toEqual([['tests/a.test.ts', MIN_WEIGHT], ['tests/b.test.ts', 2.5]])
  })

  it('an import-heavy file with fast tests outweighs a light file with slower tests', () => {
    const heavy = { collectDuration: 18000, setupDuration: 2000, duration: 1000 }
    const light = { collectDuration: 100, duration: 5000 }
    const modules = [passedModule('tests/h1.test.ts', heavy), passedModule('tests/h2.test.ts', heavy), passedModule('tests/l1.test.ts', light), passedModule('tests/l2.test.ts', light)]
    const weights = fileWeightsOf(modules)
    expect(weights['tests/h1.test.ts']!).toBeGreaterThan(weights['tests/l1.test.ts']!)

    const shards = balanceShards(Object.keys(weights), weights, 3)
    const shardOf = (file: string): number => shards.findIndex(shard => shard.includes(file))
    expect(shardOf('tests/h1.test.ts')).not.toBe(shardOf('tests/h2.test.ts'))
  })
})

describe('the reporter run at the report merge', () => {
  let root: string | undefined
  afterEach(() => {
    if (root !== undefined)
      rmSync(root, { recursive: true, force: true })
  })

  const testModule = (file: string, state: string, diagnostic: WholeFileTimings): TestModule => ({ moduleId: path.join(root!, file), state: () => state, diagnostic: () => diagnostic }) as unknown as TestModule

  it('writes each passed file\'s whole wall time, relative to the root, beside the JSON report', () => {
    root = mkdtempSync(path.join(tmpdir(), 'file-weights-'))
    const reporter = new FileWeightsReporter()
    reporter.onInit({ config: { root, outputFile: 'out/reports/vitest.json' } } as unknown as Vitest)
    reporter.onTestRunEnd([
      testModule('tests/heavy.test.ts', 'passed', timings({ prepareDuration: 400, setupDuration: 600, collectDuration: 3000, duration: 200 })),
      testModule('tests/broke.test.ts', 'failed', timings({ duration: 900 })),
    ])
    expect(JSON.parse(readFileSync(path.join(root, 'out/reports', FILE_WEIGHTS_NAME), 'utf8'))).toEqual({ 'tests/heavy.test.ts': 4.2 })
  })

  it('finds the JSON report in either form of --outputFile, and refuses a run that names none', () => {
    expect(jsonReportOf({ outputFile: 'a/vitest.json' })).toBe('a/vitest.json')
    expect(jsonReportOf({ outputFile: { json: 'b/vitest.json', junit: 'b/junit.xml' } })).toBe('b/vitest.json')
    expect(jsonReportOf({ outputFile: { junit: 'c/junit.xml' } })).toBeUndefined()
    expect(() => new FileWeightsReporter().onInit({ config: { root: tmpdir() } } as unknown as Vitest)).toThrow(/names no --outputFile/)
  })
})

describe('the CI report-merge step', () => {
  interface Step { name?: string, run?: string, with?: { name?: string, path?: string } }
  const steps = (parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: { required: { steps: Step[] } } }).jobs.required.steps

  it('the CI report-merge step writes the whole-file weights into the vitest-report artifact', () => {
    const merge = steps.find(step => step.run?.includes('--merge-reports'))
    expect(merge?.run).toContain(REPORTER_REFERENCE)
    const jsonReport = /--merge-reports[^\n]*--outputFile=(\S+)/.exec(merge!.run!)?.[1]
    expect(jsonReport).toBe(JSON_REPORT_PATH)

    const upload = steps.find(step => step.with?.name === 'vitest-report')
    const uploaded = (upload?.with?.path ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')
    expect(uploaded).toEqual(expect.arrayContaining([jsonReport, FILE_WEIGHTS_PATH]))
  })
})

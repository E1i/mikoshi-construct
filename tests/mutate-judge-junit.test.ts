import { describe, expect, it } from 'vitest'
import { applyMutation, judgeExit, MUTATE_JUDGE_EXIT, runJudge } from '../src/commands/mutate/index.js'
import { MutateWorld } from './mutate-world.js'

const SOURCE = 'src/limit.ts'
const TEST_FILE = 'tests/test_limit.py'
const ORIGINAL = 'export const within = (a: number, b: number) => a < b\n'
const LINE = `M1 | ${SOURCE} | find: \`a < b\` → \`a <= b\` | red: ${TEST_FILE} › tests.test_limit › test_strict`

function junitReport(status: 'passed' | 'failed', timestamp?: string): string {
  const suiteTimestamp = timestamp == null ? '' : ` timestamp="${timestamp}"`
  const body = status === 'failed' ? '><failure message="x"/></testcase>' : ' />'
  return `<?xml version="1.0"?><testsuites><testsuite name="pytest" tests="1"${suiteTimestamp}><testcase classname="tests.test_limit" name="test_strict" file="${TEST_FILE}"${body}</testsuite></testsuites>`
}

function applied(): { w: MutateWorld, appliedAt: number } {
  const w = new MutateWorld()
  w.write(SOURCE, ORIGINAL)
  const green = w.rawReport('green.xml', junitReport('passed', new Date().toISOString()))
  expect(runJudge({ dir: w.root, report: green, baseline: true, format: 'junit-xml' }).status).toBe('baseline-recorded')
  const brief = w.brief([LINE])
  const result = applyMutation({ dir: w.root, from: brief, id: 'M1' })
  if (result.status !== 'applied')
    throw new Error(`apply refused: ${result.refusal}`)
  return { w, appliedAt: result.record.appliedAt }
}

describe('mutate judge --format junit-xml', () => {
  it('reads a full cycle on a JUnit report as matched', () => {
    const { w } = applied()
    const red = w.rawReport('red.xml', junitReport('failed', new Date().toISOString()))
    const result = runJudge({ dir: w.root, report: red, id: 'M1', format: 'junit-xml' })

    expect(result).toMatchObject({ status: 'judged', outcome: 'named-red', matched: true })
    expect(judgeExit(result)).toBe(MUTATE_JUDGE_EXIT.matched)
  })

  it('refuses a JUnit report with no timestamp, naming the missing start time, and records no baseline', () => {
    const w = new MutateWorld()
    const green = w.rawReport('green.xml', junitReport('passed'))
    const result = runJudge({ dir: w.root, report: green, baseline: true, format: 'junit-xml' })

    expect(result.status).toBe('refused')
    expect(result).toMatchObject({ refusal: 'report-unreadable' })
    if (result.status === 'refused')
      expect(result.detail).toMatch(/start time/i)
    expect(w.mutations()).toEqual([])
  })

  it('treats a JUnit report timestamped before the mutation was applied as no witness', () => {
    const { w, appliedAt } = applied()
    const before = new Date(appliedAt - 60_000).toISOString()
    const red = w.rawReport('red.xml', junitReport('failed', before))
    const result = runJudge({ dir: w.root, report: red, id: 'M1', format: 'junit-xml' })

    expect(result.status).toBe('no-witness')
    expect(judgeExit(result)).toBe(MUTATE_JUDGE_EXIT.noWitness)
  })
})

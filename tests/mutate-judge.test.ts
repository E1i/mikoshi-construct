import type { JudgeResult } from '../src/commands/mutate/judge.js'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyMutation, judgeExit, MUTATE_JUDGE_EXIT, printJudge, runJudge } from '../src/commands/mutate/index.js'
import { readMutationRecord } from '../src/commands/mutate/record.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { failing, MutateWorld, passing } from './mutate-world.js'

const SOURCE = 'src/limit.ts'
const TEST_FILE = 'tests/limit.test.ts'
const ORIGINAL = 'export function within(a: number, b: number): boolean {\n  return a < b\n}\n'
const LINE = `M1 | ${SOURCE} | find: \`a < b\` → \`a <= b\` | red: ${TEST_FILE} › within › is strict | \`expected true to be false\``

function applied(source = ORIGINAL, line = LINE, id = 'M1'): { w: MutateWorld, appliedAt: number, brief: string } {
  const w = new MutateWorld()
  w.write(SOURCE, source)
  const green = w.report('green.json', Date.now(), [passing(TEST_FILE, 'within', 'is strict')])
  expect(runJudge({ dir: w.root, report: green, baseline: true }).status).toBe('baseline-recorded')
  const brief = w.brief([line])
  const result = applyMutation({ dir: w.root, from: brief, id })
  if (result.status !== 'applied')
    throw new Error(`apply refused: ${result.refusal}`)
  return { w, appliedAt: result.record.appliedAt, brief }
}

function printed(result: JudgeResult): string {
  let out = ''
  printJudge(createUi(resolveTheme({ plain: true, johnny: false }), (text) => {
    out += text
  }), result)
  return out
}

describe('mutate judge --baseline', () => {
  it('refuses a red report and records nothing', () => {
    const w = new MutateWorld()
    w.write(SOURCE, ORIGINAL)
    const red = w.report('red.json', Date.now(), [passing(TEST_FILE, 'within', 'is strict'), failing(TEST_FILE, 'within', 'is total')])
    const result = runJudge({ dir: w.root, report: red, baseline: true })

    expect(result).toMatchObject({ status: 'refused', refusal: 'report-red' })
    expect(judgeExit(result)).toBe(MUTATE_JUDGE_EXIT.refused)
    expect(w.mutations()).toEqual([])
  })

  it('records the startTime of a green report', () => {
    const w = new MutateWorld()
    const green = w.report('green.json', 1_700_000_000_000, [passing(TEST_FILE, 'within', 'is strict')])

    expect(runJudge({ dir: w.root, report: green, baseline: true }).status).toBe('baseline-recorded')
    expect(w.mutations()).toEqual(['baseline.json'])
    expect(JSON.parse(w.bytes('.construct/mutations/baseline.json').toString())).toMatchObject({ startTime: 1_700_000_000_000 })
  })
})

describe('mutate judge --id', () => {
  it('restores byte for byte when the replacement text was already in the file before apply', () => {
    const source = `export const inclusive = (a: number, b: number): boolean => a <= b\n${ORIGINAL}`
    const { w, appliedAt } = applied(source)
    const report = w.report('m1.json', appliedAt + 1, [failing(TEST_FILE, 'within', 'is strict')])
    const result = runJudge({ dir: w.root, report, id: 'M1' })

    expect(result).toMatchObject({ status: 'judged', outcome: 'named-red', matched: true })
    expect(w.bytes(SOURCE).equals(Buffer.from(source))).toBe(true)
    expect(w.mutations()).toEqual(['baseline.json'])
  })

  it('names the other test when a test other than the named one turned red', () => {
    const { w, appliedAt } = applied()
    const report = w.report('m1.json', appliedAt + 1, [
      passing(TEST_FILE, 'within', 'is strict'),
      failing(TEST_FILE, 'bounds', 'is strict'),
      passing('tests/other.test.ts', 'other'),
    ])
    const result = runJudge({ dir: w.root, report, id: 'M1' })

    expect(result).toMatchObject({ status: 'judged', outcome: 'other-red', matched: false, failures: [{ file: TEST_FILE, titles: ['bounds', 'is strict'] }] })
    expect(judgeExit(result)).toBe(MUTATE_JUDGE_EXIT.unmatched)
    expect(printed(result)).toContain(`${TEST_FILE} › bounds › is strict`)
    expect(w.bytes(SOURCE).toString()).toBe(ORIGINAL)
  })

  it('a report that started before apply is no witness, and the file is still restored', () => {
    const { w, appliedAt } = applied()
    const report = w.report('stale.json', appliedAt - 1, [failing(TEST_FILE, 'within', 'is strict')])
    const result = runJudge({ dir: w.root, report, id: 'M1' })

    expect(result.status).toBe('no-witness')
    expect(judgeExit(result)).toBe(MUTATE_JUDGE_EXIT.noWitness)
    expect(w.bytes(SOURCE).toString()).toBe(ORIGINAL)
    expect(w.mutations()).toEqual(['baseline.json'])
  })

  it('a foreign edit after apply is not erased', () => {
    const { w, appliedAt } = applied()
    const foreign = `${ORIGINAL}// someone else's line\n`
    w.write(SOURCE, foreign)
    const report = w.report('m1.json', appliedAt + 1, [failing(TEST_FILE, 'within', 'is strict')])
    const result = runJudge({ dir: w.root, report, id: 'M1' })

    expect(result).toMatchObject({ status: 'hard-failure', cause: 'file-changed', copy: '.construct/mutations/M1.orig' })
    expect(judgeExit(result)).toBe(MUTATE_JUDGE_EXIT.hardFailure)
    expect(w.bytes(SOURCE).toString()).toBe(foreign)
    expect(w.mutations()).toEqual(['M1.json', 'M1.orig', 'baseline.json'])
    expect(printed(result)).toContain('.construct/mutations/M1.orig')
  })

  it('a broken report still restores the file byte for byte', () => {
    const { w } = applied()
    const report = w.rawReport('broken.json', '{"startTime": 17, "testResults": [')
    const result = runJudge({ dir: w.root, report, id: 'M1' })

    expect(result.status).toBe('no-witness')
    expect(w.bytes(SOURCE).equals(Buffer.from(ORIGINAL))).toBe(true)
    expect(w.mutations()).toEqual(['baseline.json'])
  })

  it('after a hard failure a second apply with the same id refuses', () => {
    const { w, appliedAt, brief } = applied()
    w.write(SOURCE, `${ORIGINAL}// someone else's line\n`)
    const report = w.report('m1.json', appliedAt + 1, [failing(TEST_FILE, 'within', 'is strict')])
    expect(runJudge({ dir: w.root, report, id: 'M1' }).status).toBe('hard-failure')
    w.write(SOURCE, ORIGINAL)
    const again = applyMutation({ dir: w.root, from: brief, id: 'M1' })

    expect(again).toMatchObject({ status: 'refused', refusal: 'record-exists' })
    expect(w.bytes(SOURCE).toString()).toBe(ORIGINAL)
    expect(readMutationRecord(w.root, 'M1')?.appliedAt).toBe(appliedAt)
  })

  it('refuses when two tests with the same title sit in different describe blocks', () => {
    const { w, appliedAt } = applied()
    const report = w.report('m1.json', appliedAt + 1, [
      passing(TEST_FILE, 'within', 'is strict'),
      failing(TEST_FILE, 'within', 'is strict'),
      failing(TEST_FILE, 'bounds', 'is strict'),
    ])
    const result = runJudge({ dir: w.root, report, id: 'M1' })

    expect(result).toMatchObject({ status: 'refused', refusal: 'named-test-ambiguous', detail: '2' })
    expect(judgeExit(result)).toBe(MUTATE_JUDGE_EXIT.refused)
    expect(w.bytes(SOURCE).toString()).toBe(ORIGINAL)
  })

  it('a green prediction with nothing failing matches', () => {
    const { w, appliedAt } = applied(ORIGINAL, `M3 | ${SOURCE} | find: \`a < b\` → \`b > a\` | red: green`, 'M3')
    const report = w.report('m3.json', appliedAt + 1, [passing(TEST_FILE, 'within', 'is strict')])
    const result = runJudge({ dir: w.root, report, id: 'M3' })

    expect(result).toMatchObject({ status: 'judged', outcome: 'nothing-red', matched: true })
    expect(judgeExit(result)).toBe(MUTATE_JUDGE_EXIT.matched)
    expect(w.bytes(SOURCE).toString()).toBe(ORIGINAL)
  })

  it('nothing turning red under a named prediction says the criterion does not tell the implementation apart', () => {
    const { w, appliedAt } = applied()
    const report = w.report('m1.json', appliedAt + 1, [passing(TEST_FILE, 'within', 'is strict')])
    const result = runJudge({ dir: w.root, report, id: 'M1' })

    expect(result).toMatchObject({ status: 'judged', outcome: 'nothing-red', matched: false })
    expect(printed(result)).toContain('the criterion does not tell the implementation apart')
  })

  it('sets the restored file back to its original modification time, so the next mutation needs no new baseline', () => {
    const { w, appliedAt, brief } = applied()
    const report = w.report('m1.json', appliedAt + 1, [failing(TEST_FILE, 'within', 'is strict')])
    expect(runJudge({ dir: w.root, report, id: 'M1' }).status).toBe('judged')
    expect(existsSync(path.join(w.root, '.construct/mutations/M1.json'))).toBe(false)
    expect(applyMutation({ dir: w.root, from: brief, id: 'M1' }).status).toBe('applied')
  })
})

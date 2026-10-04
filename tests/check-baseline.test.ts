import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/check-baseline.mjs')

interface StepResult {
  step: string
  exitCode: number
  failures: string[] | null
}

interface Baseline {
  steps: StepResult[]
  set: string[] | null
  sha256: string | null
}

interface CheckBaseline {
  checkBaseline: (steps: string[], cwd: string) => Baseline
}

const { checkBaseline } = await import(pathToFileURL(SCRIPT).href) as CheckBaseline

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'check-baseline-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function redStep(name: string, output: string): string {
  writeFileSync(path.join(dir, name), output)
  return `cat ${name}; exit 1`
}

function failuresOf(name: string, output: string): string[] | null {
  return checkBaseline([redStep(name, output)], dir).steps[0]!.failures
}

function eslintOutput(problems: string[]): string {
  return [
    '',
    path.join(dir, 'src/bad.ts'),
    ...problems,
    '',
    `✖ ${problems.length} problems (${problems.length} errors, 0 warnings)`,
    '',
  ].join('\n')
}

const UNUSED = 'error  \'unused\' is assigned a value but never used  unused-imports/no-unused-vars'
const OTHER_UNUSED = 'error  \'other\' is assigned a value but never used  unused-imports/no-unused-vars'

function vitestOutput(failed: string[]): string {
  return [
    '',
    ' RUN  v5.0.0 /repo',
    '',
    `⎯⎯⎯⎯⎯⎯⎯ Failed Tests ${failed.length} ⎯⎯⎯⎯⎯⎯⎯`,
    '',
    ...failed.flatMap(name => [` FAIL  ${name}`, 'AssertionError: expected 1 to be 2 // Object.is equality', '']),
  ].join('\n')
}

describe('every step runs whatever the step before it did', () => {
  it('gives two results for the steps false and echo ok, the second one run', () => {
    const baseline = checkBaseline(['false', 'echo ok'], dir)
    expect(baseline.steps.map(({ step, exitCode }) => ({ step, exitCode }))).toEqual([
      { step: 'false', exitCode: 1 },
      { step: 'echo ok', exitCode: 0 },
    ])
  })

  it('gives every green step an empty failure list and the set its sha256', () => {
    const baseline = checkBaseline(['true', 'echo ok'], dir)
    expect(baseline.steps.map(step => step.failures)).toEqual([[], []])
    expect(baseline.set).toEqual([])
    expect(baseline.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives a red step no parser recognises null, and then the set and its sha256 are null', () => {
    const baseline = checkBaseline([redStep('custom.txt', 'composition: architecture/init.md is stale\n'), 'true'], dir)
    expect(baseline.steps.map(step => step.failures)).toEqual([null, []])
    expect(baseline.set).toBeNull()
    expect(baseline.sha256).toBeNull()
  })
})

describe('an eslint failure is its file and rule, counted', () => {
  it('keeps the set when the same error moves three lines down', () => {
    const before = failuresOf('before.txt', eslintOutput([`  1:7  ${UNUSED}`]))
    const after = failuresOf('after.txt', eslintOutput([`  4:7  ${UNUSED}`]))
    expect(before).toEqual(['src/bad.ts › unused-imports/no-unused-vars'])
    expect(after).toEqual(before)
  })

  it('counts a second occurrence of the same rule in the same file', () => {
    const once = failuresOf('once.txt', eslintOutput([`  1:7  ${UNUSED}`]))
    const twice = failuresOf('twice.txt', eslintOutput([`  1:7  ${UNUSED}`, `  2:7  ${OTHER_UNUSED}`]))
    expect(twice).toEqual([...once!, ...once!])
  })
})

describe('a test failure is its file and full name, with a repeat number', () => {
  it('reads the describe chain of a vitest failure', () => {
    expect(failuresOf('vitest.txt', vitestOutput(['tests/a.test.ts > outer > inner > fails']))).toEqual(['tests/a.test.ts › outer › inner › fails'])
  })

  it('gives a renamed test a new identity', () => {
    const before = failuresOf('before.txt', vitestOutput(['tests/a.test.ts > outer > fails']))
    const after = failuresOf('after.txt', vitestOutput(['tests/a.test.ts > outer > fails loudly']))
    expect(after).not.toEqual(before)
  })

  it('keeps the identities of tests that changed places', () => {
    const before = failuresOf('before.txt', vitestOutput(['tests/a.test.ts > first', 'tests/a.test.ts > second']))
    const after = failuresOf('after.txt', vitestOutput(['tests/a.test.ts > second', 'tests/a.test.ts > first']))
    expect(after).toEqual(before)
  })

  it('numbers a repeated full name', () => {
    expect(failuresOf('vitest.txt', vitestOutput(['tests/a.test.ts > same', 'tests/a.test.ts > same']))).toEqual(['tests/a.test.ts › same', 'tests/a.test.ts › same #2'])
  })

  it('names a vitest file that fails as a whole file › <suite>, which hides every test inside it', () => {
    const output = [' FAIL  tests/broken.test.ts [ tests/broken.test.ts ]', 'Error: Cannot find module \'./missing.js\''].join('\n')
    expect(failuresOf('vitest.txt', output)).toEqual(['tests/broken.test.ts › <suite>'])
  })

  it('reads jest failures, a jest file that fails to run as file › <suite>, and stops at the summary', () => {
    const output = [
      'FAIL tests/a.test.js',
      '  ● outer › fails',
      '',
      '    expect(received).toBe(expected)',
      '  ● Console',
      'FAIL tests/broken.test.js',
      '  ● Test suite failed to run',
      '',
      'Summary of all failing tests',
      'FAIL tests/a.test.js',
      '  ● outer › fails',
    ].join('\n')
    expect(failuresOf('jest.txt', output)).toEqual(['tests/a.test.js › outer › fails', 'tests/broken.test.js › <suite>'])
  })
})

describe('a tsc failure is its file, code and message, counted', () => {
  it('reads the plain and the pretty format without the line', () => {
    const plain = failuresOf('plain.txt', 'src/a.ts(3,14): error TS2322: Type \'string\' is not assignable to type \'number\'.\n')
    const pretty = failuresOf('pretty.txt', 'src/a.ts:9:2 - error TS2322: Type \'string\' is not assignable to type \'number\'.\n')
    expect(plain).toEqual(['src/a.ts › TS2322 › Type \'string\' is not assignable to type \'number\'.'])
    expect(pretty).toEqual(plain)
  })
})

describe('the set and its sha256', () => {
  const lint = (): string => redStep('lint.txt', eslintOutput([`  1:7  ${UNUSED}`]))
  const test = (): string => redStep('test.txt', vitestOutput(['tests/a.test.ts > fails']))

  it('prefixes each failure with its step', () => {
    expect(checkBaseline([test()], dir).set).toEqual([`${test()} › tests/a.test.ts › fails`])
  })

  it('keeps the sha256 when the steps come in another order', () => {
    expect(checkBaseline([test(), lint()], dir).sha256).toBe(checkBaseline([lint(), test()], dir).sha256)
  })

  it('changes the sha256 when a new failure appears', () => {
    const before = checkBaseline([lint(), test()], dir).sha256
    const after = checkBaseline([lint(), redStep('test.txt', vitestOutput(['tests/a.test.ts > fails', 'tests/a.test.ts > new']))], dir).sha256
    expect(after).not.toBe(before)
  })
})

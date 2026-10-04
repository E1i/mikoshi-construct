import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/check-baseline')
const ROOT_PLACEHOLDER = '<root>'

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8').replaceAll(ROOT_PLACEHOLDER, dir)
}

function fixtureFailures(name: string): string[] | null {
  return failuresOf(name, fixture(name))
}

const UNUSED = 'bad.ts › unused-imports/no-unused-vars'

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

describe('an eslint failure is its file and rule, counted (eslint 10.10.0 stylish)', () => {
  it('keeps the set when the same error moves three lines down', () => {
    const before = fixtureFailures('eslint-10.10.0-stylish.txt')
    expect(before).toEqual([UNUSED, UNUSED])
    expect(fixtureFailures('eslint-10.10.0-stylish-moved.txt')).toEqual(before)
  })

  it('counts a second occurrence of the same rule in the same file', () => {
    expect(fixtureFailures('eslint-10.10.0-stylish-once.txt')).toEqual([UNUSED])
    expect(fixtureFailures('eslint-10.10.0-stylish.txt')).toEqual([UNUSED, UNUSED])
  })
})

describe('a test failure is its file and full name, with a repeat number', () => {
  it('reads vitest 5.0.0: the describe chain, a repeated name numbered, a file that fails as a whole as file › <suite>', () => {
    expect(fixtureFailures('vitest-5.0.0.txt')).toEqual([
      'bad.test.ts › outer › fails first',
      'bad.test.ts › outer › inner › fails second',
      'bad.test.ts › outer › same name',
      'bad.test.ts › outer › same name #2',
      'broken.test.ts › <suite>',
    ])
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

  it('reads jest 30.5.2 the same way, with a file that fails to run as file › <suite>', () => {
    expect(fixtureFailures('jest-30.5.2.txt')).toEqual([
      'tests/a.test.js › outer › fails first',
      'tests/a.test.js › outer › inner › fails second',
      'tests/a.test.js › outer › same name',
      'tests/a.test.js › outer › same name #2',
      'tests/broken.test.js › <suite>',
    ])
  })

  it('stops reading jest at its summary of all failing tests, which repeats every failure', () => {
    expect(fixtureFailures('jest-30.5.2-summary.txt')).toEqual(fixtureFailures('jest-30.5.2.txt'))
  })
})

describe('a tsc failure is its file, code and message, counted (tsc 5.9.3)', () => {
  it('reads the plain and the pretty format without the line', () => {
    const plain = fixtureFailures('tsc-5.9.3-plain.txt')
    expect(plain).toEqual(['probe-cb/bad.ts › TS2322 › Type \'string\' is not assignable to type \'number\'.'])
    expect(fixtureFailures('tsc-5.9.3-pretty.txt')).toEqual(plain)
  })
})

describe('the set and its sha256', () => {
  const lint = (): string => redStep('lint.txt', fixture('eslint-10.10.0-stylish.txt'))
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

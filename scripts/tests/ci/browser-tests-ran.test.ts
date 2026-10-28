import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Assertion {
  status: string
}

interface Report {
  testResults: { name: string, assertionResults: Assertion[] }[]
}

interface BrowserTestsRan {
  declaredTests: (source: string) => number
  problemsOf: (report: Report | undefined, expected: Record<string, number>) => string[]
}

const SCRIPT = path.resolve(import.meta.dirname, '..', '..', 'ci/browser-tests-ran.mjs')
const { declaredTests, problemsOf } = await import(pathToFileURL(SCRIPT).href) as BrowserTestsRan

const FILE = 'tests/browser-lab.test.ts'

function reportOf(...statuses: string[]): Report {
  return { testResults: [{ name: path.resolve(FILE), assertionResults: statuses.map(status => ({ status })) }] }
}

describe('a browser test that checked nothing is red', () => {
  it('a report where every expected browser test passed has no problem', () => {
    expect(problemsOf(reportOf('passed', 'passed', 'passed'), { [FILE]: 3 })).toEqual([])
  })

  it('a skipped browser test is a problem', () => {
    expect(problemsOf(reportOf('passed', 'skipped'), { [FILE]: 1 })).toEqual([`${FILE}: 1 skipped or todo`])
  })

  it('a todo browser test is a problem', () => {
    expect(problemsOf(reportOf('passed', 'todo'), { [FILE]: 1 })).toEqual([`${FILE}: 1 skipped or todo`])
  })

  it('fewer passed tests than expected is a problem', () => {
    expect(problemsOf(reportOf('passed'), { [FILE]: 3 })).toEqual([`${FILE}: 1 passed, 3 expected`])
  })

  it('a failed browser test is a problem', () => {
    expect(problemsOf(reportOf('passed', 'failed'), { [FILE]: 1 })).toEqual([`${FILE}: 1 failed`])
  })

  it('a file missing from the report is a problem', () => {
    expect(problemsOf({ testResults: [] }, { [FILE]: 1 })).toEqual([`${FILE}: not in the report`])
  })

  it('a missing report is a problem', () => {
    expect(problemsOf(undefined, { [FILE]: 1 })).toEqual(['vitest wrote no report'])
  })
})

describe('the floor of expected tests', () => {
  it('counts it, it.for and it.each declarations, with or without a type argument', () => {
    const source = [
      'it(\'a\', () => {})',
      'it.for<[string]>([[\'x\']])(\'b\', () => {})',
      'it.each([[1]])(\'c\', () => {})',
      'it.skip(\'d\', () => {})',
      'submit(1)',
    ].join('\n')
    expect(declaredTests(source)).toBe(3)
  })
})

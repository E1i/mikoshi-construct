import { describe, expect, it } from 'vitest'
import { EXCERPT_CHARS, EXCERPT_LINES, failureExcerpt } from '../../nodes/witness/witness-executor.js'

const ESC = String.fromCharCode(27)

describe('the failure excerpt of a red witness', () => {
  it('keeps the failed test names and the error lines, and drops the rest of the output', () => {
    const output = [
      ' RUN  v3.0.0',
      ` ${ESC}[31m×${ESC}[39m the thing > does it`,
      ' FAIL  scripts/tests/a.test.ts > the thing > does it',
      'AssertionError: expected 1 to be 2',
      '   Duration 2.02s',
    ].join('\n')

    const excerpt = failureExcerpt(output)

    expect(excerpt).toContain('× the thing > does it')
    expect(excerpt).toContain('FAIL  scripts/tests/a.test.ts > the thing > does it')
    expect(excerpt).toContain('AssertionError: expected 1 to be 2')
    expect(excerpt).not.toContain('Duration')
    expect(excerpt).not.toContain(ESC)
  })

  it('is cut at the line limit and the character limit', () => {
    const many = Array.from({ length: EXCERPT_LINES + 10 }, (_, index) => `FAIL test ${index}`).join('\n')
    expect(failureExcerpt(many).split('\n')).toHaveLength(EXCERPT_LINES)

    const long = `FAIL ${'x'.repeat(EXCERPT_CHARS * 2)}`
    expect(failureExcerpt(long)).toHaveLength(EXCERPT_CHARS)
  })

  it('is empty when the output names no failure', () => {
    expect(failureExcerpt('all good\nDuration 1s')).toBe('')
  })
})

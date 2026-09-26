import { describe, expect, it } from 'vitest'
import { parseJunitReport } from '../src/model/junit-report.js'
import { wasExecuted } from '../src/model/vitest-report.js'

function ok(report: ReturnType<typeof parseJunitReport>): asserts report is Exclude<ReturnType<typeof parseJunitReport>, { unreadable: string }> {
  if ('unreadable' in report)
    throw new Error(`expected a readable report, got: ${report.unreadable}`)
}

describe('parseJunitReport', () => {
  it('reads a passed self-closing testcase as executed', () => {
    const report = parseJunitReport('<testsuites><testsuite><testcase classname="tests.test_api" name="test_health" file="tests/test_api.py"/></testsuite></testsuites>')
    ok(report)
    expect(report.files).toHaveLength(1)
    expect(report.files[0].file).toBe('tests/test_api.py')
    expect(wasExecuted(report.files[0])).toBe(true)
  })

  it('reads a <skipped> testcase as not executed', () => {
    const report = parseJunitReport('<testsuite><testcase name="t" file="a.py"><skipped message="skip"/></testcase></testsuite>')
    ok(report)
    expect(wasExecuted(report.files[0])).toBe(false)
  })

  it('reads <failure> and <error> testcases as executed', () => {
    const failed = parseJunitReport('<testsuite><testcase name="t" file="a.py"><failure message="boom"/></testcase></testsuite>')
    const errored = parseJunitReport('<testsuite><testcase name="t" file="a.py"><error message="boom"/></testcase></testsuite>')
    ok(failed)
    ok(errored)
    expect(wasExecuted(failed.files[0])).toBe(true)
    expect(wasExecuted(errored.files[0])).toBe(true)
  })

  it('decodes the five standard XML entities in attributes', () => {
    const report = parseJunitReport('<testsuite><testcase name="a &amp; b &lt;x&gt; &quot;q&quot; &apos;s&apos;" file="a.py"/></testsuite>')
    ok(report)
    expect(report.files[0].tests[0].titles).toContain('a & b <x> "q" \'s\'')
  })

  it('leaves a testcase with no file attribute unmapped, never turning a class name into a path', () => {
    const report = parseJunitReport('<testsuite><testcase classname="tests.test_api" name="t"/></testsuite>')
    ok(report)
    expect(report.files[0].file).not.toBe('tests.test_api')
    expect(report.files[0].file).not.toContain('test_api')
  })

  it('never throws on a file it cannot parse, reading it as unreadable', () => {
    expect(() => parseJunitReport('')).not.toThrow()
    expect(parseJunitReport('')).toHaveProperty('unreadable')
    expect(parseJunitReport('<testsuites><testcase')).toHaveProperty('unreadable')
  })

  it('ignores CDATA and text content around testcases', () => {
    const report = parseJunitReport('<testsuite><system-out><![CDATA[noise]]></system-out><testcase name="t" file="a.py"/>some text</testsuite>')
    ok(report)
    expect(report.files).toHaveLength(1)
  })

  it('reads a failure whose CDATA mentions <skipped> as a test that ran and failed', () => {
    const report = parseJunitReport('<testsuite><testcase name="t" file="a.py"><failure message="boom"><![CDATA[expected a <skipped> element]]></failure></testcase></testsuite>')
    ok(report)
    expect(wasExecuted(report.files[0])).toBe(true)
    expect(report.files[0].failed).toBe(true)
  })

  it('reads no testcase out of CDATA or a comment', () => {
    const report = parseJunitReport('<testsuite><!-- <testcase name="c" file="c.py"/> --><system-out><![CDATA[<testcase name="d" file="d.py"/>]]></system-out><testcase name="t" file="a.py"/></testsuite>')
    ok(report)
    expect(report.files.map(file => file.file)).toEqual(['a.py'])
  })
})

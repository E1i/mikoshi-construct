import { describe, expect, it } from 'vitest'
import { parseJunitReport } from '../src/model/junit-report.js'

function ok(report: ReturnType<typeof parseJunitReport>): asserts report is Exclude<ReturnType<typeof parseJunitReport>, { unreadable: string }> {
  if ('unreadable' in report)
    throw new Error(`expected a readable report, got: ${report.unreadable}`)
}

describe('parseJunitReport startTime', () => {
  it('reads the timestamp attribute of a testsuite as the run start time', () => {
    const report = parseJunitReport('<testsuite name="pytest" timestamp="2024-01-01T00:00:00" tests="1"><testcase name="t" file="a.py"/></testsuite>')
    ok(report)
    expect(report.startTime).toBe(new Date('2024-01-01T00:00:00').getTime())
  })

  it('takes the earliest timestamp across several testsuite elements', () => {
    const report = parseJunitReport(`<testsuites>
      <testsuite name="a" timestamp="2024-06-01T00:00:00Z"><testcase name="t1" file="a.py"/></testsuite>
      <testsuite name="b" timestamp="2024-01-01T00:00:00Z"><testcase name="t2" file="b.py"/></testsuite>
    </testsuites>`)
    ok(report)
    expect(report.startTime).toBe(new Date('2024-01-01T00:00:00Z').getTime())
  })

  it('is null when no testsuite carries a timestamp', () => {
    const report = parseJunitReport('<testsuite name="pytest" tests="1"><testcase name="t" file="a.py"/></testsuite>')
    ok(report)
    expect(report.startTime).toBeNull()
  })

  it('is null when the timestamp attribute does not parse as a date', () => {
    const report = parseJunitReport('<testsuite name="pytest" timestamp="not-a-date" tests="1"><testcase name="t" file="a.py"/></testsuite>')
    ok(report)
    expect(report.startTime).toBeNull()
  })
})

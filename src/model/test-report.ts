import type { ReportFormat } from './schema.js'
import { readJunitReport } from './junit-report.js'
import { readVitestReport } from './vitest-report.js'

export interface ReportedTest {
  file: string
  titles: string[]
  failed: boolean
  ran: boolean
}

export interface ReportedFile {
  file: string
  failed: boolean
  tests: ReportedTest[]
}

export interface TestReport {
  startTime: number | null
  files: ReportedFile[]
}

export interface ReportUnreadable {
  unreadable: string
}

export interface Failure {
  file: string
  titles: string[] | null
}

export function failuresOf(report: TestReport): Failure[] {
  return report.files.flatMap((file): Failure[] => {
    const failedTests = file.tests.filter(test => test.failed).map(test => ({ file: file.file, titles: test.titles }))
    if (failedTests.length === 0 && file.failed)
      return [{ file: file.file, titles: null }]
    return failedTests
  })
}

export function wasExecuted(file: ReportedFile): boolean {
  return file.failed || file.tests.some(test => test.ran)
}

export function testCount(report: TestReport): number {
  return report.files.reduce((total, file) => total + file.tests.length, 0)
}

export function testsNamed(report: TestReport, file: string, titles: string[]): ReportedTest[] {
  return report.files
    .filter(reported => reported.file === file)
    .flatMap(reported => reported.tests)
    .filter(test => test.titles.length === titles.length && test.titles.every((title, index) => title === titles[index]))
}

export function readTestReport(format: ReportFormat, root: string, reportPath: string): TestReport | ReportUnreadable {
  return format === 'junit-xml' ? readJunitReport(reportPath) : readVitestReport(root, reportPath)
}

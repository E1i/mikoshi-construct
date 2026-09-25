import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

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
  startTime: number
  files: ReportedFile[]
}

export interface ReportUnreadable {
  unreadable: string
}

export interface Failure {
  file: string
  titles: string[] | null
}

const FAILED = 'failed'
const RAN = new Set(['passed', FAILED])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function relativeTo(root: string, name: string): string {
  const absolute = path.resolve(root, name)
  const bases = [root, realpathOr(root)]
  const inside = bases.map(base => path.relative(base, absolute)).find(relative => !relative.startsWith('..') && !path.isAbsolute(relative))
  return (inside ?? absolute).split(path.sep).join('/')
}

function realpathOr(root: string): string {
  try {
    return realpathSync(root)
  }
  catch {
    return root
  }
}

function reportedTest(file: string, value: unknown): ReportedTest | null {
  if (!isRecord(value) || !isStringList(value.ancestorTitles) || typeof value.title !== 'string' || typeof value.status !== 'string')
    return null
  return { file, titles: [...value.ancestorTitles, value.title], failed: value.status === FAILED, ran: RAN.has(value.status) }
}

function reportedFile(root: string, value: unknown): ReportedFile | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.status !== 'string' || !Array.isArray(value.assertionResults))
    return null
  const file = relativeTo(root, value.name)
  const tests = value.assertionResults.map(result => reportedTest(file, result))
  if (tests.some(test => test == null))
    return null
  return { file, failed: value.status === FAILED, tests: tests as ReportedTest[] }
}

export function parseVitestReport(root: string, text: string): TestReport | ReportUnreadable {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return { unreadable: 'the report is not JSON' }
  }
  if (!isRecord(parsed) || typeof parsed.startTime !== 'number' || !Array.isArray(parsed.testResults))
    return { unreadable: 'the report carries no numeric startTime and testResults list' }
  const files = parsed.testResults.map(result => reportedFile(root, result))
  if (files.some(file => file == null))
    return { unreadable: 'a testResults entry carries no name, status and assertionResults of ancestorTitles, title and status' }
  return { startTime: parsed.startTime, files: files as ReportedFile[] }
}

export function readVitestReport(root: string, reportPath: string): TestReport | ReportUnreadable {
  let text: string
  try {
    text = readFileSync(reportPath, 'utf8')
  }
  catch {
    return { unreadable: 'the report cannot be read' }
  }
  return parseVitestReport(root, text)
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

import type { ReportedFile, ReportUnreadable, TestReport } from './test-report.js'
import { readFileSync } from 'node:fs'

const UNMAPPED_FILE = '/junit-testcase-with-no-file-attribute'
const TESTSUITE_PATTERN = /<testsuite\b([^>]*)>/g

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': '\'',
  '&amp;': '&',
}

const ATTRIBUTE_PATTERN = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g
const CHARACTER_DATA_AND_COMMENTS = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g
const TESTCASE_PATTERN = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g

function decodeEntities(value: string): string {
  return value.replace(/&lt;|&gt;|&quot;|&apos;|&amp;/g, entity => ENTITIES[entity])
}

function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of text.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1] ?? match[3]
    const value = decodeEntities(match[2] ?? match[4] ?? '')
    attributes[name] = value
  }
  return attributes
}

function reportedFileFrom(attributesText: string, body: string | undefined): ReportedFile {
  const attributes = attributesOf(attributesText)
  const file = attributes.file ?? UNMAPPED_FILE
  const skipped = body !== undefined && /<skipped\b/.test(body)
  const failed = body !== undefined && !skipped && /<failure\b|<error\b/.test(body)
  return { file, failed, tests: [{ file, titles: [attributes.classname, attributes.name].filter((value): value is string => Boolean(value)), failed, ran: !skipped }] }
}

function startTimeOf(markup: string): number | null {
  const times = [...markup.matchAll(TESTSUITE_PATTERN)]
    .map(match => attributesOf(match[1]).timestamp)
    .filter((value): value is string => Boolean(value))
    .map(value => new Date(value).getTime())
    .filter(value => !Number.isNaN(value))
  return times.length === 0 ? null : Math.min(...times)
}

export function parseJunitReport(text: string): TestReport | ReportUnreadable {
  const markup = text.replace(CHARACTER_DATA_AND_COMMENTS, '')
  const files = [...markup.matchAll(TESTCASE_PATTERN)].map(match => reportedFileFrom(match[1], match[2]))
  if (files.length === 0)
    return { unreadable: 'the report carries no <testcase> element' }
  return { startTime: startTimeOf(markup), files }
}

export function readJunitReport(reportPath: string): TestReport | ReportUnreadable {
  let text: string
  try {
    text = readFileSync(reportPath, 'utf8')
  }
  catch {
    return { unreadable: 'the report cannot be read' }
  }
  return parseJunitReport(text)
}

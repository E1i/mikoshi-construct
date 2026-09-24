import type { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export type TestStatus = 'passed' | 'failed' | 'skipped'

export interface ReportedCase {
  file: string
  titles: string[]
  status: TestStatus
}

const AN_HOUR_AGO = (): Date => new Date(Date.now() - 3_600_000)

export class MutateWorld {
  readonly root: string
  readonly scratch: string

  constructor() {
    const base = mkdtempSync(path.join(tmpdir(), 'construct-mutate-'))
    this.root = path.join(base, 'repo')
    this.scratch = path.join(base, 'scratch')
    mkdirSync(this.root)
    mkdirSync(this.scratch)
  }

  write(file: string, content: string | Buffer): string {
    const target = path.join(this.root, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
    utimesSync(target, AN_HOUR_AGO(), AN_HOUR_AGO())
    return target
  }

  bytes(file: string): Buffer {
    return readFileSync(path.join(this.root, file))
  }

  brief(lines: string[]): string {
    const file = path.join(this.scratch, 'brief.md')
    writeFileSync(file, `# Brief\n\n${lines.join('\n')}\n`)
    return file
  }

  report(name: string, startTime: number, cases: ReportedCase[]): string {
    const files = [...new Set(cases.map(entry => entry.file))]
    const testResults = files.map((file) => {
      const assertionResults = cases.filter(entry => entry.file === file).map(entry => ({
        ancestorTitles: entry.titles.slice(0, -1),
        fullName: entry.titles.join(' '),
        status: entry.status,
        title: entry.titles.at(-1),
        failureMessages: [],
      }))
      return {
        name: path.join(this.root, file),
        status: assertionResults.some(entry => entry.status === 'failed') ? 'failed' : 'passed',
        message: '',
        startTime,
        assertionResults,
      }
    })
    return this.rawReport(name, JSON.stringify({ numTotalTests: cases.length, startTime, success: true, testResults }))
  }

  rawReport(name: string, text: string): string {
    const file = path.join(this.scratch, name)
    writeFileSync(file, text)
    return file
  }

  mutations(): string[] {
    const dir = path.join(this.root, '.construct/mutations')
    return existsSync(dir) ? readdirSync(dir).sort() : []
  }
}

export function passing(file: string, ...titles: string[]): ReportedCase {
  return { file, titles, status: 'passed' }
}

export function failing(file: string, ...titles: string[]): ReportedCase {
  return { file, titles, status: 'failed' }
}

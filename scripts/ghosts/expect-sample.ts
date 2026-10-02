import type { LedgerEntry } from '../../src/commands/cost/ledger.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { LEDGER_FILE, parseLedgerLine } from '../../src/commands/cost/ledger.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'

export interface SampleRow {
  run: string
  effort: string
  tokens: number
  minutes: number
}

export interface ExpectSample {
  line: string
  rows: SampleRow[]
}

interface JournalTask {
  run: string
  class: string | null
}

const MINIMUM_SAMPLE = 5
const COUNTED_STATUS = 'done'
const DASH = '—'
const APPROX = '≈'

function textLines(file: string): string[] {
  if (!existsSync(file))
    return []
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
}

export function readJournalTasks(lines: string[], warnings: string[]): JournalTask[] {
  const tasks: JournalTask[] = []
  lines.forEach((text, index) => {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    }
    catch {
      warnings.push(`journal line ${index + 1} is not JSON; skipped`)
      return
    }
    const line = raw as Record<string, unknown>
    if (line.event !== 'task' || typeof line.run !== 'string' || line.run === '')
      return
    tasks.push({ run: line.run, class: typeof line.class === 'string' ? line.class : null })
  })
  return tasks
}

export function readLedgerEntries(lines: string[], source: string, warnings: string[]): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  lines.forEach((text, index) => {
    const entry = parseLedgerLine(text)
    if (typeof entry === 'string')
      warnings.push(`${source} line ${index + 1} is malformed (${entry}); skipped`)
    else
      entries.push(entry)
  })
  return entries
}

export function joinByClass(tasks: JournalTask[], entries: LedgerEntry[], taskClass: string, effort: string | undefined): SampleRow[] {
  const runsOfClass = new Set(tasks.filter(task => task.class === taskClass).map(task => task.run))
  const seen = new Set<string>()
  const rows: SampleRow[] = []
  for (const entry of entries) {
    if (entry.run === null || !runsOfClass.has(entry.run) || seen.has(entry.run))
      continue
    if (entry.status !== COUNTED_STATUS || entry.tokens === 'unknown')
      continue
    if (effort !== undefined && entry.effort !== effort)
      continue
    seen.add(entry.run)
    rows.push({ run: entry.run, effort: entry.effort, tokens: entry.tokens, minutes: entry.seconds / 60 })
  }
  return rows
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10)
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${oneDecimal(tokens / 1_000_000)}M`
  if (tokens >= 1_000)
    return `${Math.round(tokens / 1_000)}k`
  return String(Math.round(tokens))
}

export function expectLine(rows: SampleRow[], taskClass: string, effort: string | undefined): string {
  const efforts = [...new Set(rows.map(row => row.effort))]
  if (rows.length < MINIMUM_SAMPLE)
    return `expect: none ${DASH} n=${rows.length} for ${taskClass}`
  const basis = effort ?? (efforts.length === 1 ? efforts[0] : undefined)
  if (basis === undefined)
    return `expect: none ${DASH} the sample for ${taskClass} mixes efforts ${efforts.sort().join(', ')}; pass --effort`
  return `expect: tokens ${APPROX} ${formatTokens(median(rows.map(row => row.tokens)))}, minutes ${APPROX} ${oneDecimal(median(rows.map(row => row.minutes)))} ${DASH} effort ${basis}, n=${rows.length}, median`
}

export function expectSample(journalLines: string[], ledgers: { source: string, lines: string[] }[], taskClass: string, effort: string | undefined, warnings: string[]): ExpectSample {
  const tasks = readJournalTasks(journalLines, warnings)
  const entries = ledgers.flatMap(ledger => readLedgerEntries(ledger.lines, ledger.source, warnings))
  const rows = joinByClass(tasks, entries, taskClass, effort)
  return { line: expectLine(rows, taskClass, effort), rows }
}

export function renderSample(sample: ExpectSample): string[] {
  return [sample.line, ...sample.rows.map(row => `${row.run}  tokens ${row.tokens}  minutes ${oneDecimal(row.minutes)}`)]
}

function main(): void {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { effort: { type: 'string' }, journal: { type: 'string' }, runs: { type: 'string', multiple: true } },
  })
  const taskClass = positionals[0]
  if (taskClass === undefined) {
    console.error('usage: expect-sample.ts <class> [--effort <low|medium|high>] [--journal <ghosts.jsonl>] [--runs <runs.jsonl>]...')
    process.exitCode = 1
    return
  }
  const handoffDir = process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff')
  const journal = values.journal ?? path.join(handoffDir, 'ghosts.jsonl')
  const runs = values.runs ?? [path.join(process.cwd(), LEDGER_FILE)]
  const warnings: string[] = []
  const sample = expectSample(textLines(journal), runs.map(source => ({ source, lines: textLines(source) })), taskClass, values.effort, warnings)
  for (const warning of warnings)
    console.error(warning)
  for (const line of renderSample(sample))
    console.log(line)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()

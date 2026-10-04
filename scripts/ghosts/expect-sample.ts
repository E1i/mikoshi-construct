import type { CostSource, RunStep, Step, UnreadAgent } from '../../src/commands/cost/index.js'
import type { LedgerEntry } from '../../src/commands/cost/ledger.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ClaudeCodeCostSource, knownSteps, median, MINIMUM_SAMPLE, STEPS } from '../../src/commands/cost/index.js'
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
  steps: StepExpect[]
}

export type StepExpect
  = | { kind: 'forecast', step: Step, effort: string, tokens: number, minutes: number, n: number }
    | { kind: 'none', step: Step, effort: string, n: number }

export interface SampleSource {
  source: string
  lines: string[] | null
}

export interface LadderSampleInput {
  ledgers: SampleSource[]
  effort?: string
  taskClass?: { name: string, journal: SampleSource }
  runSteps?: Map<string, RunStep[]>
}

interface JournalTask {
  run: string
  class: string | null
}

const COUNTED_STATUS = 'done'
const DASH = '—'
const APPROX = '≈'

function textLines(file: string): string[] | null {
  if (!existsSync(file))
    return null
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

export function readLedgerEntries(ledger: SampleSource, notes: string[]): LedgerEntry[] {
  if (ledger.lines === null)
    return []
  const entries: LedgerEntry[] = []
  const rejected = new Map<string, number>()
  for (const text of ledger.lines) {
    const entry = parseLedgerLine(text)
    if (typeof entry === 'string')
      rejected.set(entry, (rejected.get(entry) ?? 0) + 1)
    else
      entries.push(entry)
  }
  if (rejected.size > 0) {
    const count = [...rejected.values()].reduce((sum, value) => sum + value, 0)
    const reasons = [...rejected].map(([reason, times]) => `${times} ${reason}`).join(', ')
    notes.push(`${count} row${count === 1 ? '' : 's'} the ledger parser rejects not counted in ${ledger.source} (${reasons})`)
  }
  return entries
}

function countedRows(entries: LedgerEntry[], effort: string | undefined, runsOfClass: Set<string> | null): SampleRow[] {
  const seen = new Set<string>()
  const rows: SampleRow[] = []
  for (const entry of entries) {
    if (entry.run === null || seen.has(entry.run) || (runsOfClass !== null && !runsOfClass.has(entry.run)))
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

function runsOfClass(taskClass: LadderSampleInput['taskClass'], notes: string[], warnings: string[]): { runs: Set<string> | null, missing: string | null } {
  if (taskClass === undefined)
    return { runs: null, missing: null }
  const { name, journal } = taskClass
  if (journal.lines === null)
    return { runs: new Set(), missing: `task lines not recorded in ${journal.source}` }
  const tasks = readJournalTasks(journal.lines, warnings)
  const unclassed = tasks.filter(task => task.class === null).length
  const classNote = unclassed === 0 ? null : `class not recorded on ${unclassed} line${unclassed === 1 ? '' : 's'} in ${journal.source}`
  const runs = new Set(tasks.filter(task => task.class === name).map(task => task.run))
  if (runs.size === 0)
    return { runs, missing: classNote ?? `class ${name} not recorded in ${journal.source}` }
  if (classNote !== null)
    notes.push(classNote)
  return { runs, missing: null }
}

function selection(taskClass: string | undefined, effort: string | undefined): string {
  const parts = [...(taskClass === undefined ? [] : [`class ${taskClass}`]), ...(effort === undefined ? [] : [`effort ${effort}`])]
  return parts.length === 0 ? 'every effort' : parts.join(', ')
}

function sources(input: LadderSampleInput): string[] {
  return [`ledger ${input.ledgers.map(ledger => ledger.source).join(', ')}`, ...(input.taskClass === undefined ? [] : [`journal ${input.taskClass.journal.source}`])]
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

function headOf(rows: SampleRow[], label: string, effort: string | undefined, missing: string | null): string {
  if (missing !== null && rows.length === 0)
    return `none ${DASH} ${missing}`
  if (rows.length < MINIMUM_SAMPLE)
    return `none ${DASH} n=${rows.length} for ${label}`
  const efforts = [...new Set(rows.map(row => row.effort))]
  const basis = effort ?? (efforts.length === 1 ? efforts[0] : undefined)
  if (basis === undefined)
    return `none ${DASH} the sample for ${label} mixes efforts ${efforts.sort().join(', ')}; pass --effort`
  return `tokens ${APPROX} ${formatTokens(median(rows.map(row => row.tokens)))}, minutes ${APPROX} ${oneDecimal(median(rows.map(row => row.minutes)))} ${DASH} effort ${basis}, n=${rows.length}, median`
}

export function stepExpects(entries: LedgerEntry[], runSteps: Map<string, RunStep[]>, effort: string): StepExpect[] {
  const counted = new Set<string>()
  const perStep = new Map<Step, { tokens: number, seconds: number }[]>(STEPS.map(step => [step, []]))
  for (const entry of entries) {
    if (entry.run === null || counted.has(entry.run) || entry.status !== COUNTED_STATUS || entry.effort !== effort)
      continue
    const steps = runSteps.get(entry.run)
    if (steps === undefined)
      continue
    counted.add(entry.run)
    for (const step of STEPS) {
      const records = steps.filter(record => record.step === step)
      if (records.length > 0)
        perStep.get(step)!.push({ tokens: records.reduce((sum, record) => sum + record.tokens, 0), seconds: records.reduce((sum, record) => sum + record.seconds, 0) })
    }
  }
  return STEPS.map((step) => {
    const samples = perStep.get(step)!
    if (samples.length < MINIMUM_SAMPLE)
      return { kind: 'none', step, effort, n: samples.length }
    return { kind: 'forecast', step, effort, tokens: median(samples.map(sample => sample.tokens)), minutes: Math.round(median(samples.map(sample => sample.seconds)) / 6) / 10, n: samples.length }
  })
}

export function formatStepExpect(expected: StepExpect): string {
  if (expected.kind === 'none')
    return `${expected.step} none ${DASH} n=${expected.n} for ${expected.effort}/${expected.step}`
  return `${expected.step} tokens ${APPROX} ${formatTokens(expected.tokens)}, minutes ${APPROX} ${expected.minutes} ${DASH} n=${expected.n}`
}

function missingReason(input: LadderSampleInput, entries: LedgerEntry[], classMissing: string | null): string | null {
  if (classMissing !== null)
    return classMissing
  const unrecorded = input.ledgers.filter(ledger => ledger.lines === null || ledger.lines.length === 0).map(ledger => ledger.source)
  return entries.length === 0 && unrecorded.length > 0 ? `runs not recorded in ${unrecorded.join(', ')}` : null
}

export function ladderSample(input: LadderSampleInput, warnings: string[]): ExpectSample {
  const notes: string[] = []
  const entries = input.ledgers.flatMap(ledger => readLedgerEntries(ledger, notes))
  const { runs, missing } = runsOfClass(input.taskClass, notes, warnings)
  const rows = countedRows(entries, input.effort, runs)
  const head = headOf(rows, selection(input.taskClass?.name, input.effort), input.effort, missingReason(input, entries, missing))
  const line = [`expect: ${head}`, ...sources(input), ...notes].join('; ')
  return { line, rows, steps: input.effort === undefined ? [] : stepExpects(entries, input.runSteps ?? new Map(), input.effort) }
}

function ledgerRuns(ledgers: SampleSource[]): string[] {
  return ledgers.flatMap(ledger => (ledger.lines ?? []).map(parseLedgerLine)).flatMap(entry => typeof entry === 'string' || entry.run === null ? [] : [entry.run])
}

function unreadWarnings(unread: UnreadAgent[]): string[] {
  const byRun = new Map<string, UnreadAgent[]>()
  for (const agent of unread)
    byRun.set(agent.run, [...byRun.get(agent.run) ?? [], agent])
  return [...byRun].map(([run, agents]) => `run ${run} is left out of the step forecast: ${agents.map(agent => `agent ${agent.agent} (${agent.reason})`).join('; ')}`)
}

export function stepsOfRepository(root: string, runs: string[], warnings: string[], source: CostSource = new ClaudeCodeCostSource()): Map<string, RunStep[]> {
  const cache = knownSteps(root, runs, source)
  for (const line of cache.malformed)
    warnings.push(`step cache line ${line} is malformed; skipped`)
  warnings.push(...unreadWarnings(cache.unread))
  return cache.runs
}

export function launchStepExpects(repo: string, effort: string | null): StepExpect[] {
  if (effort === null)
    return []
  const ledger = { source: path.join(repo, LEDGER_FILE), lines: textLines(path.join(repo, LEDGER_FILE)) }
  const entries = readLedgerEntries(ledger, [])
  return stepExpects(entries, stepsOfRepository(repo, ledgerRuns([ledger]), []), effort)
}

export function renderSample(sample: ExpectSample): string[] {
  return [sample.line, ...sample.steps.map(step => `step ${formatStepExpect(step)}`), ...sample.rows.map(row => `${row.run}  tokens ${row.tokens}  minutes ${oneDecimal(row.minutes)}`)]
}

function main(): void {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { effort: { type: 'string' }, journal: { type: 'string' }, runs: { type: 'string', multiple: true } },
  })
  if (positionals.length > 1) {
    console.error('usage: expect-sample.ts [<class>] [--effort <low|medium|high>] [--journal <ghosts.jsonl>] [--runs <runs.jsonl>]...')
    process.exitCode = 1
    return
  }
  const handoffDir = process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff')
  const journal = values.journal ?? path.join(handoffDir, 'ghosts.jsonl')
  const runs = values.runs ?? [LEDGER_FILE]
  const warnings: string[] = []
  const ledgers = runs.map(source => path.resolve(source)).map(source => ({ source, lines: textLines(source) }))
  const taskClass = positionals[0] === undefined ? undefined : { name: positionals[0], journal: { source: journal, lines: textLines(journal) } }
  const runSteps = values.effort === undefined ? new Map<string, RunStep[]>() : stepsOfRepository(process.cwd(), ledgerRuns(ledgers), warnings)
  const sample = ladderSample({ ledgers, effort: values.effort, taskClass, runSteps }, warnings)
  for (const warning of warnings)
    console.error(warning)
  for (const line of renderSample(sample))
    console.log(line)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()

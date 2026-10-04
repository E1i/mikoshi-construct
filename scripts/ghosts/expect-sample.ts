import type { CostSource, RunStep, Step, UnreadAgent } from '../../src/commands/cost/index.js'
import type { LedgerEntry } from '../../src/commands/cost/ledger.js'
import type { Band } from '../../src/commands/cost/sample.js'
import type { SubagentRecord } from '../../src/commands/cost/turns.js'
import type { RoleExpect } from './role-sample.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ClaudeCodeCostSource, knownSteps, STEPS } from '../../src/commands/cost/index.js'
import { LEDGER_FILE, parseLedgerLine } from '../../src/commands/cost/ledger.js'
import { recentBand } from '../../src/commands/cost/sample.js'
import { readSubagentRecords } from '../../src/commands/cost/turns.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { roleExpects } from './role-sample.js'

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
  roles: RoleExpect[]
  contour: string | null
}

export type Subsample = 'sketch' | 'no sketch'

export type StepExpect
  = | { kind: 'forecast', step: Step, effort: string, tokens: number, p25: number, p75: number, minutes: number, n: number, subsample?: Subsample }
    | { kind: 'none', step: Step, effort: string, n: number, subsample?: Subsample }

export interface SampleSource {
  source: string
  lines: string[] | null
}

export interface LadderSampleInput {
  ledgers: SampleSource[]
  effort?: string
  taskClass?: { name: string, journal: SampleSource }
  runSteps?: Map<string, RunStep[]>
  sketch?: { wanted: boolean, journal: SampleSource }
  turns?: SubagentRecord[] | null
}

interface JournalTask {
  run: string
  class: string | null
  sketch: boolean | null
}

const COUNTED_STATUS = 'done'
const DASH = '—'
const APPROX = '≈'
const BAND = 'p25–p75'
const CONTOUR_LABEL = 'sum of step bands'

function textLines(file: string): string[] | null {
  if (!existsSync(file))
    return null
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
}

function sketchOf(line: Record<string, unknown>): boolean | null {
  if (typeof line.sketch === 'string')
    return true
  return line.sketch === null ? false : null
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
    tasks.push({ run: line.run, class: typeof line.class === 'string' ? line.class : null, sketch: sketchOf(line) })
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

function oldestFirst(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => a.at.localeCompare(b.at))
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

function formatBand(band: { p25: number, p75: number }): string {
  return `${BAND} ${formatTokens(band.p25)}–${formatTokens(band.p75)}`
}

function headOf(rows: SampleRow[], label: string, effort: string | undefined, missing: string | null): string {
  if (missing !== null && rows.length === 0)
    return `none ${DASH} ${missing}`
  const tokens = recentBand(rows.map(row => row.tokens))
  if (tokens.kind === 'none')
    return `none ${DASH} n=${tokens.n} for ${label}`
  const efforts = [...new Set(rows.map(row => row.effort))]
  const basis = effort ?? (efforts.length === 1 ? efforts[0] : undefined)
  if (basis === undefined)
    return `none ${DASH} the sample for ${label} mixes efforts ${efforts.sort().join(', ')}; pass --effort`
  const minutes = recentBand(rows.map(row => row.minutes))
  const medianMinutes = minutes.kind === 'band' ? minutes.median : 0
  return `tokens ${APPROX} ${formatTokens(tokens.median)}, minutes ${APPROX} ${oneDecimal(medianMinutes)} ${DASH} effort ${basis}, n=${tokens.n}, median, ${formatBand(tokens)}`
}

export interface ImplementSubsample {
  subsample: Subsample
  runs: Set<string>
}

const SUBSAMPLED_STEP: Step = 'implement'

export function stepExpects(entries: LedgerEntry[], runSteps: Map<string, RunStep[]>, effort: string, implement: ImplementSubsample | null = null): StepExpect[] {
  const counted = new Set<string>()
  const perStep = new Map<Step, { tokens: number, seconds: number }[]>(STEPS.map(step => [step, []]))
  for (const entry of oldestFirst(entries)) {
    if (entry.run === null || counted.has(entry.run) || entry.status !== COUNTED_STATUS || entry.effort !== effort)
      continue
    const steps = runSteps.get(entry.run)
    if (steps === undefined)
      continue
    counted.add(entry.run)
    for (const step of STEPS) {
      if (step === SUBSAMPLED_STEP && implement !== null && !implement.runs.has(entry.run))
        continue
      const records = steps.filter(record => record.step === step)
      if (records.length > 0)
        perStep.get(step)!.push({ tokens: records.reduce((sum, record) => sum + record.tokens, 0), seconds: records.reduce((sum, record) => sum + record.seconds, 0) })
    }
  }
  return STEPS.map((step) => {
    const samples = perStep.get(step)!
    const subsample = step === SUBSAMPLED_STEP && implement !== null ? { subsample: implement.subsample } : {}
    const tokens = recentBand(samples.map(sample => sample.tokens))
    const seconds = recentBand(samples.map(sample => sample.seconds))
    if (tokens.kind === 'none' || seconds.kind === 'none')
      return { kind: 'none', step, effort, n: tokens.n, ...subsample }
    return { kind: 'forecast', step, effort, tokens: tokens.median, p25: tokens.p25, p75: tokens.p75, minutes: Math.round(seconds.median / 6) / 10, n: tokens.n, ...subsample }
  })
}

function stepNoneReason(expected: StepExpect): string {
  return `n=${expected.n} for ${expected.effort}/${expected.step}${expected.subsample === undefined ? '' : `, ${expected.subsample}`}`
}

export function formatStepExpect(expected: StepExpect): string {
  if (expected.kind === 'none')
    return `${expected.step} none ${DASH} ${stepNoneReason(expected)}`
  const subsample = expected.subsample === undefined ? '' : ` (${expected.subsample})`
  return `${expected.step}${subsample} tokens ${APPROX} ${formatTokens(expected.tokens)}, minutes ${APPROX} ${expected.minutes}, ${formatBand(expected)} ${DASH} n=${expected.n}`
}

function roleNoneReason(expected: RoleExpect): string {
  return expected.missing ?? `n=${expected.band.n} for role ${expected.role}`
}

export function formatRoleExpect(expected: RoleExpect): string {
  if (expected.band.kind === 'none')
    return `${expected.role} none ${DASH} ${roleNoneReason(expected)}`
  return `${expected.role} tokens ${APPROX} ${formatTokens(expected.band.median)}, minutes not recorded, ${formatBand(expected.band)} ${DASH} n=${expected.band.n}`
}

interface ContourPart {
  name: string
  band: Band
  reason: string
}

function contourParts(steps: StepExpect[], roles: RoleExpect[]): ContourPart[] {
  return [
    ...steps.map(step => ({ name: step.step, band: step.kind === 'forecast' ? { kind: 'band' as const, median: step.tokens, p25: step.p25, p75: step.p75, n: step.n } : { kind: 'none' as const, n: step.n }, reason: stepNoneReason(step) })),
    ...roles.map(role => ({ name: role.role, band: role.band, reason: roleNoneReason(role) })),
  ]
}

export function formatContour(steps: StepExpect[], roles: RoleExpect[]): string {
  const parts = contourParts(steps, roles)
  const covered = parts.flatMap(part => part.band.kind === 'band' ? [{ name: part.name, band: part.band }] : [])
  const uncovered = parts.filter(part => part.band.kind === 'none').map(part => `${part.name} (${part.reason})`)
  const notCovered = uncovered.length === 0 ? '' : `; not covered: ${uncovered.join(', ')}`
  if (covered.length === 0)
    return `contour none ${DASH} no step has a sample${notCovered}`
  const sum = (pick: (band: { median: number, p25: number, p75: number }) => number): number => covered.reduce((total, part) => total + pick(part.band), 0)
  return `contour tokens ${APPROX} ${formatTokens(sum(band => band.median))}, ${formatBand({ p25: sum(band => band.p25), p75: sum(band => band.p75) })} (${CONTOUR_LABEL}) ${DASH} covers ${covered.map(part => part.name).join(', ')}${notCovered}`
}

function missingReason(input: LadderSampleInput, entries: LedgerEntry[], classMissing: string | null): string | null {
  if (classMissing !== null)
    return classMissing
  const unrecorded = input.ledgers.filter(ledger => ledger.lines === null || ledger.lines.length === 0).map(ledger => ledger.source)
  return entries.length === 0 && unrecorded.length > 0 ? `runs not recorded in ${unrecorded.join(', ')}` : null
}

function implementSubsample(input: LadderSampleInput, entries: LedgerEntry[], notes: string[], warnings: string[]): ImplementSubsample | null {
  if (input.sketch === undefined)
    return null
  const { wanted, journal } = input.sketch
  const known = new Map<string, boolean>()
  for (const task of readJournalTasks(journal.lines ?? [], warnings)) {
    if (task.sketch !== null)
      known.set(task.run, task.sketch)
  }
  const unknown = new Set(entries.filter(entry => entry.run !== null && entry.status === COUNTED_STATUS && entry.effort === input.effort && !known.has(entry.run)).map(entry => entry.run))
  if (unknown.size > 0)
    notes.push(`${unknown.size} run${unknown.size === 1 ? '' : 's'} without a sketch record in ${journal.source} not counted for implement`)
  return { subsample: wanted ? 'sketch' : 'no sketch', runs: new Set([...known].filter(([, sketch]) => sketch === wanted).map(([run]) => run)) }
}

export function ladderSample(input: LadderSampleInput, warnings: string[]): ExpectSample {
  const notes: string[] = []
  const entries = input.ledgers.flatMap(ledger => readLedgerEntries(ledger, notes))
  const { runs, missing } = runsOfClass(input.taskClass, notes, warnings)
  const all = countedRows(oldestFirst(entries), input.effort, runs)
  const head = headOf(all, selection(input.taskClass?.name, input.effort), input.effort, missingReason(input, entries, missing))
  const subsample = input.effort === undefined ? null : implementSubsample(input, entries, notes, warnings)
  const line = [`expect: ${head}`, ...sources(input), ...notes].join('; ')
  const steps = input.effort === undefined ? [] : stepExpects(entries, input.runSteps ?? new Map(), input.effort, subsample)
  const roles = input.turns === undefined ? [] : roleExpects(input.turns)
  const contour = input.effort === undefined || input.turns === undefined ? null : formatContour(steps, roles)
  const shown = recentBand(all.map(row => row.tokens)).n
  return { line, rows: all.slice(all.length - shown), steps, roles, contour }
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
  return [
    sample.line,
    ...sample.steps.map(step => `step ${formatStepExpect(step)}`),
    ...sample.roles.map(role => `role ${formatRoleExpect(role)}`),
    ...(sample.contour === null ? [] : [sample.contour]),
    ...sample.rows.map(row => `${row.run}  tokens ${row.tokens}  minutes ${oneDecimal(row.minutes)}`),
  ]
}

const SKETCH_ANSWERS = ['yes', 'no']

function main(): void {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { effort: { type: 'string' }, sketch: { type: 'string' }, journal: { type: 'string' }, runs: { type: 'string', multiple: true } },
  })
  if (positionals.length > 1 || (values.sketch !== undefined && !SKETCH_ANSWERS.includes(values.sketch))) {
    console.error('usage: expect-sample.ts [<class>] [--effort <low|medium|high>] [--sketch <yes|no>] [--journal <ghosts.jsonl>] [--runs <runs.jsonl>]...')
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
  const sketch = values.sketch === undefined ? undefined : { wanted: values.sketch === 'yes', journal: { source: journal, lines: textLines(journal) } }
  const sample = ladderSample({ ledgers, effort: values.effort, taskClass, runSteps, sketch, turns: readSubagentRecords(process.cwd()) }, warnings)
  for (const warning of warnings)
    console.error(warning)
  for (const line of renderSample(sample))
    console.log(line)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()

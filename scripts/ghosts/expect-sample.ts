import type { CostSource, ExpectInput, ImplementSubsample, RoleBand, RunStep, SampleRow, SampleSource, StepExpect } from '../../src/commands/cost/index.js'
import type { LedgerEntry } from '../../src/commands/cost/ledger.js'
import type { SubagentRecord } from '../../src/commands/cost/turns.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { countsTowardSteps } from '../../src/commands/cost/expect.js'
import { ClaudeCodeCostSource, expectFor, formatContour as formatContourIn, formatRoleExpect, formatStepExpect as formatStepExpectIn, formatTokens, readLedgerEntries as readLedgerEntriesIn, stepExpects, stepsOfRepository as stepsOfRepositoryIn } from '../../src/commands/cost/index.js'
import { LEDGER_FILE, parseLedgerLine } from '../../src/commands/cost/ledger.js'
import { readSubagentRecords } from '../../src/commands/cost/turns.js'
import { PLAIN_LORE } from '../../src/ui/lore.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { roleExpects } from './role-sample.js'

export type { ImplementSubsample, SampleRow, SampleSource, StepExpect, Subsample } from '../../src/commands/cost/index.js'
export { formatTokens, stepExpects }

export interface ExpectSample {
  line: string
  rows: SampleRow[]
  steps: StepExpect[]
  roles: ReturnType<typeof roleExpects>
  contour: string | null
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
  return readLedgerEntriesIn(ledger, notes, PLAIN_LORE)
}

export function formatStepExpect(expected: StepExpect): string {
  return formatStepExpectIn(expected, PLAIN_LORE)
}

export function formatContour(steps: StepExpect[], roles: RoleBand[]): string {
  return formatContourIn(steps, roles, PLAIN_LORE)
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

function implementSubsample(input: LadderSampleInput, entries: LedgerEntry[], warnings: string[]): { sample: ImplementSubsample, notes: string[] } {
  const notes: string[] = []
  const sketch = input.sketch!
  const { wanted, journal } = sketch
  const known = new Map<string, boolean>()
  for (const task of readJournalTasks(journal.lines ?? [], warnings)) {
    if (task.sketch !== null)
      known.set(task.run, task.sketch)
  }
  for (const entry of entries) {
    if (entry.run !== null && entry.sketch !== undefined)
      known.set(entry.run, entry.sketch !== null)
  }
  const unknown = new Set(entries.filter(entry => entry.run !== null && countsTowardSteps(entry, input.effort) && !known.has(entry.run)).map(entry => entry.run))
  if (unknown.size > 0)
    notes.push(`${unknown.size} run${unknown.size === 1 ? '' : 's'} without a sketch record in ${journal.source} not counted for implement`)
  return { sample: { subsample: wanted ? 'sketch' : 'no sketch', runs: new Set([...known].filter(([, recorded]) => recorded === wanted).map(([run]) => run)) }, notes }
}

export function ladderSample(input: LadderSampleInput, warnings: string[]): ExpectSample {
  const classNotes: string[] = []
  const { runs, missing } = runsOfClass(input.taskClass, classNotes, warnings)
  const roles = input.turns === undefined ? undefined : roleExpects(input.turns)
  const expected: ExpectInput = {
    ledgers: input.ledgers,
    effort: input.effort,
    taskClass: input.taskClass?.name,
    runsOfClass: runs,
    missing,
    extraSources: input.taskClass === undefined ? [] : [`journal ${input.taskClass.journal.source}`],
    classNotes,
    runSteps: input.runSteps,
    implement: input.sketch === undefined ? undefined : entries => implementSubsample(input, entries, warnings),
    roles,
  }
  const result = expectFor(expected, PLAIN_LORE)
  return { line: result.line, rows: result.rows, steps: result.steps, roles: roles ?? [], contour: result.contour }
}

function ledgerRuns(ledgers: SampleSource[]): string[] {
  return ledgers.flatMap(ledger => (ledger.lines ?? []).map(parseLedgerLine)).flatMap(entry => typeof entry === 'string' || entry.run === null ? [] : [entry.run])
}

export function stepsOfRepository(root: string, runs: string[], warnings: string[], source: CostSource = new ClaudeCodeCostSource()): Map<string, RunStep[]> {
  return stepsOfRepositoryIn(root, runs, warnings, PLAIN_LORE, source)
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
    ...sample.roles.map(role => `role ${formatRoleExpect(role, PLAIN_LORE)}`),
    ...(sample.contour === null ? [] : [sample.contour]),
    ...sample.rows.map(row => `${row.run}  tokens ${row.tokens}  minutes ${Math.round(row.minutes * 10) / 10}`),
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

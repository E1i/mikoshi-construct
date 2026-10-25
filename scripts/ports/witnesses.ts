import type { Shell, ShellResult } from './worktree.js'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gitIn, lastLine, stageSketch, tailLines } from './worktree.js'

export interface Witness { criterion: string, command: string }

export type Refuse = (step: string, problem: string | null) => void
export type Timer = <T>(name: string, run: () => T) => T

export interface TreeRun {
  tree: string
  base: string
  shell: Shell
  log: (line: string) => void
  refuse: Refuse
  time: Timer
}

export interface TreeTask {
  acceptance: Witness[]
  invariants: Witness[]
  harnessCommand: string | null
  sketchSha: string | null
  changed: string[] | null
  witnessesDir: string
}

const NOT_RUN_STATUSES = [126, 127]
const ATTACH_CARRIER_SOURCES = ['templates/ai/claude/', 'templates/attach/earlier-carriers.json']
const EARLIER_CARRIERS_CHECK = 'pnpm exec tsx scripts/attach/earlier-carriers.ts --check'
const LOCKFILE = 'pnpm-lock.yaml'
const DEPENDENCY_FILES = ['package.json', LOCKFILE]
const INSTALL = 'pnpm install --frozen-lockfile'
const WITNESSES_SUFFIX = /\.witnesses$/
const QUALITY_STEPS = 'quality:steps'
const PNPM_STEP = /^pnpm\s+(?:run\s+)?(\S+)/
const SCRIPT_HEADER = /^> \S+ (\S+)/
const NEGATION = /^!\s/
const PIPED_GREP = /^(.*[^|])\|\s*grep(\s.*)$/
const INVERT_LONG_FLAG = /\s--invert-match(?=\s|$)/g
const SHORT_FLAGS_WITH_INVERT = /\s-([A-UW-Z]*)v([A-Z]*)(?=\s|$)/gi
const NO_TEST_MATCHED = /matched no test|No test files found/
const FAILED_TESTS = /\b\d+ failed\b/
const TESTS_LINE = /^\s*Tests\s/
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*m/g
const VITEST = /\bvitest\b/
const TEST_FILE = /^[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/
const TEST_NAME = /\s(?:-t|--testNamePattern)[=\s]+(?:'([^']*)'|"([^"]*)"|(\S+))/

interface GrepWitness { witness: Witness, probe: string }

export function grepMatchProbe(command: string): string | null {
  const piped = PIPED_GREP.exec(command.trim().replace(NEGATION, '').trim())
  if (piped === null)
    return null
  const args = piped[2]
    .replace(INVERT_LONG_FLAG, '')
    .replace(SHORT_FLAGS_WITH_INVERT, (_, before: string, after: string) => `${before}${after}` === '' ? '' : ` -${before}${after}`)
  return `${piped[1]}| grep${args} >/dev/null`
}

function grepWitnesses(witnesses: Witness[]): GrepWitness[] {
  return witnesses.flatMap((witness) => {
    const probe = grepMatchProbe(witness.command)
    return probe === null ? [] : [{ witness, probe }]
  })
}

export function grepRefusal(witness: Witness, sides: string): string {
  return `grep witness "${witness.criterion}" matches its pattern on neither ${sides}: nothing it reads prints what it looks for, so its red on the base is not red for a reason; grep where the output is written (a reporter with an outputFile writes there, not to stdout)`
}

export interface TestTarget { file: string, name: string | null }

export function testTargetOf(command: string): TestTarget | null {
  if (!VITEST.test(command))
    return null
  const file = command.split(/\s+/).find(token => TEST_FILE.test(token))
  if (file === undefined)
    return null
  const named = TEST_NAME.exec(command)
  return { file, name: named === null ? null : named[1] ?? named[2] ?? named[3] }
}

function absentOnBase(tree: string, witness: Witness): boolean {
  const target = testTargetOf(witness.command)
  if (target === null)
    return false
  const file = path.join(tree, target.file)
  if (!existsSync(file))
    return true
  return target.name !== null && !readFileSync(file, 'utf8').includes(target.name)
}

function reportsFailedTest(output: string): boolean {
  return output.replace(ANSI, '').split('\n').some(line => TESTS_LINE.test(line) && FAILED_TESTS.test(line))
}

function baseRedRefusal(witness: Witness, result: ShellResult, base: string): string | null {
  if (result.status === null || NOT_RUN_STATUSES.includes(result.status))
    return `witness "${witness.criterion}" did not run on the base ${base} (exit ${result.status ?? 'none'}: ${lastLine(result.output)}); red for a missing command is not red for a reason`
  if (result.status === 0)
    return `witness "${witness.criterion}" exits 0 on the clean base ${base}: it is green before any change, so no implementation can make it red`
  if (NO_TEST_MATCHED.test(result.output))
    return `witness "${witness.criterion}" matched no test on the base ${base} while its test file and name are there (${lastLine(result.output)}): a witness that runs no test is not red for a reason`
  if (testTargetOf(witness.command) !== null && !reportsFailedTest(result.output))
    return `witness "${witness.criterion}" exits ${result.status} on the base ${base} with no failing test (${lastLine(result.output)}): a crash or an environment error is not red for a reason`
  return null
}

function greenRefusal(label: string, witness: Witness, result: ShellResult, where: string): string | null {
  return result.status === 0 ? null : `${label} "${witness.criterion}" exits ${result.status ?? 'without a status'} on ${where}: ${lastLine(result.output)}`
}

function headRefusal(label: string, witness: Witness, result: ShellResult, where: string): string | null {
  if (NO_TEST_MATCHED.test(result.output))
    return `${label} "${witness.criterion}" matched no test on ${where} (${lastLine(result.output)}): a witness that runs no test proves nothing`
  return greenRefusal(label, witness, result, where)
}

function firstFailingStep(stepsScript: string, output: string): string | null {
  const steps = stepsScript.split('&&').map(step => PNPM_STEP.exec(step.trim())?.[1]).filter(step => step !== undefined)
  const started = output.split('\n').map(line => SCRIPT_HEADER.exec(line.trim())?.[1]).filter(step => step !== undefined && steps.includes(step))
  return started.at(-1) ?? null
}

function qualityStepsOf(tree: string): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(tree, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return manifest.scripts?.[QUALITY_STEPS] ?? ''
  }
  catch {
    return ''
  }
}

function harnessLogOf(witnessesDir: string): string {
  return witnessesDir.replace(WITNESSES_SUFFIX, '.p8.log')
}

function harnessRefusal(run: TreeRun, task: TreeTask, where: string): string | null {
  if (task.harnessCommand === null)
    return null
  const log = harnessLogOf(task.witnessesDir)
  rmSync(log, { force: true })
  const result = run.shell(task.harnessCommand, run.tree)
  if (result.status === 0)
    return null
  writeFileSync(log, result.output)
  const step = firstFailingStep(qualityStepsOf(run.tree), result.output)
  const failing = step === null ? `no step of ${QUALITY_STEPS} named in its output` : `first failing step of ${QUALITY_STEPS}: ${step}`
  return `harness "${task.harnessCommand}" exits ${result.status ?? 'without a status'} on ${where}; ${failing}; log ${log}\n${tailLines(result.output)}`
}

function firstProblem<T>(items: T[], problemOf: (item: T) => string | null): string | null {
  for (const item of items) {
    const problem = problemOf(item)
    if (problem !== null)
      return problem
  }
  return null
}

function lintTargets(tree: string, sketchChanged: string[] | null, witnessesDir: string): string[] {
  if (sketchChanged !== null)
    return sketchChanged.filter(file => /\.test\.ts$/.test(file) && existsSync(path.join(tree, file)))
  if (!existsSync(witnessesDir))
    return []
  return readdirSync(witnessesDir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map((entry) => {
      const relative = path.relative(witnessesDir, path.join(entry.parentPath, entry.name))
      mkdirSync(path.dirname(path.join(tree, relative)), { recursive: true })
      copyFileSync(path.join(entry.parentPath, entry.name), path.join(tree, relative))
      return relative.split(path.sep).join('/')
    })
    .filter(file => /\.[cm]?[jt]sx?$/.test(file))
}

function invariantsBesideHarness(run: TreeRun, task: TreeTask): Witness[] {
  task.invariants.forEach((witness, index) => {
    if (witness.command === task.harnessCommand)
      run.log(`I${index + 1}: covered by harness`)
  })
  return task.invariants.filter(witness => witness.command !== task.harnessCommand)
}

function lint(run: TreeRun, files: string[], label: string, where: string): void {
  if (files.length > 0)
    run.refuse('P6', greenRefusal(label, { criterion: files.join(' '), command: '' }, run.shell(`pnpm exec eslint ${files.join(' ')}`, run.tree), where))
}

function reinstallRefusal(run: TreeRun, sketchSha: string, where: string): string | null {
  const { tree, base, shell } = run
  const changed = gitIn(tree, ['diff', '--name-only', base, sketchSha, '--', ...DEPENDENCY_FILES])
  if (changed === '' || !existsSync(path.join(tree, LOCKFILE)))
    return null
  return shell(INSTALL, tree).status === 0 ? null : `${INSTALL} failed on ${where}`
}

export function runOnTree(run: TreeRun, task: TreeTask): void {
  const { tree, base, shell, refuse, time } = run
  const baseShort = base.slice(0, 7)
  const harnessRuns = task.sketchSha !== null && task.changed !== null
  const invariants = harnessRuns ? invariantsBesideHarness(run, task) : task.invariants
  const absent = new Set([...task.acceptance, ...invariants].filter(witness => absentOnBase(tree, witness)))
  const presentOnBase = (witnesses: Witness[]): Witness[] => witnesses.filter(witness => !absent.has(witness))
  let unmatchedOnBase: GrepWitness[] = []
  if (existsSync(path.join(tree, LOCKFILE)))
    time('install', () => refuse('P7', shell(INSTALL, tree).status === 0 ? null : `${INSTALL} failed on the base ${baseShort}`))
  time('P7 base', () => {
    task.acceptance.filter(witness => absent.has(witness)).forEach(witness => run.log(`witness "${witness.criterion}": red on the base ${baseShort} by absence: its test is not in the base tree; checked on the head`))
    invariants.filter(witness => absent.has(witness)).forEach(witness => run.log(`invariant "${witness.criterion}": not applicable on the base ${baseShort}: new test; checked on the head only`))
    refuse('P7', firstProblem(presentOnBase(task.acceptance), witness => baseRedRefusal(witness, shell(witness.command, tree), baseShort)))
    refuse('P7', firstProblem(presentOnBase(invariants), witness => greenRefusal('invariant', witness, shell(witness.command, tree), `the clean base ${baseShort}`)))
    unmatchedOnBase = grepWitnesses(task.acceptance).filter(({ probe }) => shell(probe, tree).status !== 0)
  })
  if (task.sketchSha === null || task.changed === null) {
    unmatchedOnBase.forEach(({ witness }) => run.log(`grep witness "${witness.criterion}": not checked, Sketch: none leaves no head; red by absence until done:check probes it on the head`))
    time('P6 lint', () => lint(run, lintTargets(tree, null, task.witnessesDir), 'lint of the ready witness files, no --fix,', 'a throwaway tree of the base'))
    run.log('positive control: none (Sketch: none)')
    return
  }
  const { sketchSha, changed } = task
  const where = `the sketch ${sketchSha.slice(0, 7)} staged on the base ${baseShort}`
  time('P8 sketch', () => {
    stageSketch(tree, base, sketchSha)
    refuse('P8', reinstallRefusal(run, sketchSha, where))
    refuse('P8', firstProblem(unmatchedOnBase, ({ witness, probe }) => shell(probe, tree).status === 0 ? null : grepRefusal(witness, `the base ${baseShort} nor ${where}`)))
    refuse('P8', firstProblem(task.acceptance, witness => headRefusal('positive control', witness, shell(witness.command, tree), where)))
    refuse('P8', firstProblem(invariants, witness => headRefusal('invariant', witness, shell(witness.command, tree), where)))
  })
  time('P8 harness', () => refuse('P8', harnessRefusal(run, task, where)))
  time('P6 lint', () => lint(run, lintTargets(tree, changed, ''), 'lint of the sketch test files, no --fix,', where))
  if (changed.some(file => ATTACH_CARRIER_SOURCES.some(source => file.startsWith(source))))
    time('P9 carriers', () => refuse('P9', greenRefusal('earlier-carriers --check', { criterion: 'the known set', command: EARLIER_CARRIERS_CHECK }, shell(EARLIER_CARRIERS_CHECK, tree), where)))
}

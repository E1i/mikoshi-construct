import type { Shell, ShellResult } from './worktree.js'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { admittedReachOf, isChangeWitness, unjudgedCommand } from '../../src/commands/intake/check.js'
import { pathsNamedBy } from '../../src/commands/intake/command-word.js'
import { commandLine, GENERATED_FILES } from '../core/generated-files.js'
import { gitIn, lastLine, stageSketch, tailLines } from './worktree.js'

export const TECHNOLOGY_WORDS = ['grep', 'shell'] as const

export interface Witness { criterion: string, command: string, onBase?: { command: string, stated: string } }

export type Refuse = (step: string, problem: string | null) => void
export type Timer = <T>(name: string, run: () => T) => T

interface TreeContext {
  tree: string
  base: string
  log: (line: string) => void
  refuse: Refuse
}

export interface TreeRun extends TreeContext {
  shell: Shell
  time: Timer
}

export interface AsyncTreeRun extends TreeContext {
  shell: (command: string, cwd: string) => Promise<ShellResult>
  phase?: (name: string) => void
}

export const BASE_PHASE = 'P7 base'

type Commands<T> = Generator<string, T, ShellResult>

interface TreePhase {
  name: string
  commands: Commands<void>
}

export interface TreeTask {
  acceptance: Witness[]
  invariants: Witness[]
  harnessCommand: string | null
  sketchSha: string | null
  changed: string[] | null
  witnessesDir: string
  creates: string[]
}

const NOT_RUN_STATUSES = [126, 127]
const ATTACH_CARRIER_SOURCES = ['templates/ai/claude/', GENERATED_FILES.earlierCarriers.path]
const EARLIER_CARRIERS_CHECK = commandLine(GENERATED_FILES.earlierCarriers.check)
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
const REFUSAL_TAIL_LINES = 6
const TAIL_JOINER = ' · '
const VITEST = /\bvitest\b/
const TEST_FILE = /^[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/
const TEST_NAME = /\s(?:-t|--testNamePattern)[=\s]+(?:'([^']*)'|"([^"]*)"|(\S+))/
const TRAILING_SLASHES = /\/+$/

interface GrepWitness { witness: Witness, probe: string }

export function grepMatchProbe(command: string): string | null {
  const piped = PIPED_GREP.exec(unjudgedCommand(command).trim().replace(NEGATION, '').trim())
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

function isNegated(witness: Pick<Witness, 'command'>): boolean {
  return NEGATION.test(witness.command.trim()) || unjudgedCommand(witness.command) !== witness.command
}

function absentOnBase(tree: string, witness: Pick<Witness, 'command'>): boolean {
  if (isNegated(witness))
    return false
  const target = testTargetOf(witness.command)
  if (target === null)
    return false
  const file = path.join(tree, target.file)
  if (!existsSync(file))
    return true
  return target.name !== null && !readFileSync(file, 'utf8').includes(target.name)
}

function addedOnHead(tree: string, base: string, head: string | null): string[] {
  return head === null ? [] : gitIn(tree, ['diff', '--name-only', '--diff-filter=A', base, head]).split('\n').filter(file => file !== '')
}

function createdOnHead(tree: string, base: string, task: TreeTask): string[] {
  const declared = task.creates.map(entry => entry.replace(TRAILING_SLASHES, '')).filter(entry => !existsSync(path.join(tree, entry)))
  return [...new Set([...addedOnHead(tree, base, task.sketchSha), ...declared])]
}

function isCreated(tree: string, relative: string, added: readonly string[]): boolean {
  const scope = relative.replace(TRAILING_SLASHES, '')
  if (added.includes(scope))
    return true
  return !existsSync(path.join(tree, scope)) && added.some(file => file.startsWith(`${scope}/`))
}

function overCreatedPaths(tree: string, witness: Witness, added: readonly string[]): boolean {
  const created = (relative: string): boolean => isCreated(tree, relative, added)
  const named = pathsNamedBy(witness.command, relative => created(relative) || existsSync(path.join(tree, relative)))
  return named.length > 0 && named.every(created)
}

function changeWitnessReason(tree: string, witness: Witness, added: readonly string[]): string | null {
  if (isChangeWitness(witness.criterion))
    return 'as its wording states'
  return overCreatedPaths(tree, witness, added) ? 'over paths the head creates, and nothing else' : null
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
  if (!isNegated(witness) && testTargetOf(witness.command) !== null && !reportsFailedTest(result.output))
    return `witness "${witness.criterion}" exits ${result.status} on the base ${base} with no failing test (${lastLine(result.output)}): a crash or an environment error is not red for a reason`
  return null
}

function statedBaseRefusal(witness: Witness, onBase: NonNullable<Witness['onBase']>, result: ShellResult, base: string): string | null {
  const running = result.status === 0 ? null : baseRedRefusal({ criterion: witness.criterion, command: onBase.command }, result, base)
  if (running !== null)
    return running
  const met = result.status === 0 ? onBase.stated === 'pass' : onBase.stated === 'fail' || onBase.stated === `exit:${result.status}`
  return met ? null : `witness "${witness.criterion}" exits ${result.status ?? 'without a status'} on the base ${base}, and its field states base ${onBase.stated}`
}

function outputTail(output: string): string {
  return tailLines(output.replace(ANSI, ''), REFUSAL_TAIL_LINES).split('\n').map(line => line.trim()).join(TAIL_JOINER) || 'no output'
}

function greenRefusal(label: string, witness: Witness, result: ShellResult, where: string): string | null {
  return result.status === 0 ? null : `${label} "${witness.criterion}" exits ${result.status ?? 'without a status'} on ${where}: ${outputTail(result.output)}`
}

function headRefusal(label: string, witness: Witness, result: ShellResult, where: string): string | null {
  if (NO_TEST_MATCHED.test(result.output))
    return `${label} "${witness.criterion}" matched no test on ${where} (${lastLine(result.output)}): a witness that runs no test proves nothing`
  if (result.status === 0 && isNegated(witness) && testTargetOf(witness.command) !== null && !reportsFailedTest(result.output))
    return `${label} "${witness.criterion}" exits 0 on ${where} only because its negated test run failed with no failing test (${lastLine(result.output)}): a crash or an environment error is not the failure it names`
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

function* harnessRefusal(run: TreeContext, task: TreeTask, where: string): Commands<string | null> {
  if (task.harnessCommand === null)
    return null
  const log = harnessLogOf(task.witnessesDir)
  rmSync(log, { force: true })
  const result = yield task.harnessCommand
  if (result.status === 0)
    return null
  writeFileSync(log, result.output)
  const step = firstFailingStep(qualityStepsOf(run.tree), result.output)
  const failing = step === null ? `no step of ${QUALITY_STEPS} named in its output` : `first failing step of ${QUALITY_STEPS}: ${step}`
  return `harness "${task.harnessCommand}" exits ${result.status ?? 'without a status'} on ${where}; ${failing}; log ${log}\n${tailLines(result.output)}`
}

function* firstProblem<T>(items: T[], problemOf: (item: T) => Commands<string | null>): Commands<string | null> {
  for (const item of items) {
    const problem = yield* problemOf(item)
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

function invariantsBesideHarness(run: TreeContext, task: TreeTask): Witness[] {
  task.invariants.forEach((witness, index) => {
    if (witness.command === task.harnessCommand)
      run.log(`I${index + 1}: covered by harness`)
  })
  return task.invariants.filter(witness => witness.command !== task.harnessCommand)
}

function* lint(run: TreeContext, files: string[], label: string, where: string): Commands<void> {
  if (files.length > 0)
    run.refuse('P6', greenRefusal(label, { criterion: files.join(' '), command: '' }, yield `pnpm exec eslint ${files.join(' ')}`, where))
}

function* reinstallRefusal(run: TreeContext, sketchSha: string, where: string): Commands<string | null> {
  const { tree, base } = run
  const changed = gitIn(tree, ['diff', '--name-only', base, sketchSha, '--', ...DEPENDENCY_FILES])
  if (changed === '' || !existsSync(path.join(tree, LOCKFILE)))
    return null
  return (yield INSTALL).status === 0 ? null : `${INSTALL} failed on ${where}`
}

function* treePhases(run: TreeContext, task: TreeTask): Generator<TreePhase, void, void> {
  const { tree, base, refuse } = run
  const baseShort = base.slice(0, 7)
  const harnessRuns = task.sketchSha !== null && task.changed !== null
  const declared = harnessRuns ? invariantsBesideHarness(run, task) : task.invariants
  const added = createdOnHead(tree, base, task)
  const absent = new Set([...task.acceptance, ...declared].filter(witness => absentOnBase(tree, witness.onBase ?? witness)))
  const presentOnBase = (witnesses: Witness[]): Witness[] => witnesses.filter(witness => !absent.has(witness))
  const redOverCreated: Witness[] = []
  const unmatchedOnBase: GrepWitness[] = []
  if (existsSync(path.join(tree, LOCKFILE))) {
    yield { name: 'install', commands: (function* (): Commands<void> {
      refuse('P7', (yield INSTALL).status === 0 ? null : `${INSTALL} failed on the base ${baseShort}`)
    })() }
  }
  yield { name: BASE_PHASE, commands: (function* (): Commands<void> {
    task.acceptance.filter(witness => absent.has(witness)).forEach(witness => run.log(`witness "${witness.criterion}": red on the base ${baseShort} by absence: its test is not in the base tree; checked on the head`))
    declared.filter(witness => absent.has(witness)).forEach(witness => run.log(`invariant "${witness.criterion}": not applicable on the base ${baseShort}: new test; checked on the head only`))
    refuse('P7', yield* firstProblem(presentOnBase(task.acceptance), function* (witness) {
      if (witness.onBase !== undefined)
        return statedBaseRefusal(witness, witness.onBase, yield witness.onBase.command, baseShort)
      return baseRedRefusal(witness, yield witness.command, baseShort)
    }))
    refuse('P7', yield* firstProblem(presentOnBase(declared), function* (witness) {
      const result = yield witness.command
      const reason = result.status === 0 ? null : changeWitnessReason(tree, witness, added)
      if (reason === null)
        return greenRefusal('invariant', witness, result, `the clean base ${baseShort}`)
      redOverCreated.push(witness)
      run.log(`invariant "${witness.criterion}": red on the base ${baseShort} ${reason}; a change witness: checked green on the head`)
      return null
    }))
    for (const grep of grepWitnesses(task.acceptance)) {
      if ((yield grep.probe).status !== 0)
        unmatchedOnBase.push(grep)
    }
  })() }
  const acceptance = [...task.acceptance, ...redOverCreated]
  const invariants = declared.filter(witness => !redOverCreated.includes(witness))
  if (task.sketchSha === null || task.changed === null) {
    unmatchedOnBase.forEach(({ witness }) => run.log(`grep witness "${witness.criterion}": not checked, Sketch: none leaves no head; red by absence until done:check probes it on the head`))
    const readyWitnessFiles = lintTargets(tree, null, task.witnessesDir)
    yield { name: 'P6 lint', commands: lint(run, readyWitnessFiles, 'lint of the ready witness files, no --fix,', 'a throwaway tree of the base') }
    run.log('positive control: none (Sketch: none)')
    return
  }
  const { sketchSha, changed } = task
  const where = `the sketch ${sketchSha.slice(0, 7)} staged on the base ${baseShort}`
  yield { name: 'P8 sketch', commands: (function* (): Commands<void> {
    stageSketch(tree, base, sketchSha)
    refuse('P8', yield* reinstallRefusal(run, sketchSha, where))
    refuse('P8', yield* firstProblem(unmatchedOnBase, function* ({ witness, probe }) {
      return (yield probe).status === 0 ? null : grepRefusal(witness, `the base ${baseShort} nor ${where}`)
    }))
    refuse('P8', yield* firstProblem(acceptance, function* (witness) {
      return headRefusal('positive control', witness, yield witness.command, where)
    }))
    refuse('P8', yield* firstProblem(invariants, function* (witness) {
      return headRefusal('invariant', witness, yield witness.command, where)
    }))
  })() }
  yield { name: 'P8 harness', commands: (function* (): Commands<void> {
    refuse('P8', yield* harnessRefusal(run, task, where))
  })() }
  yield { name: 'P6 lint', commands: (function* (): Commands<void> {
    yield* lint(run, lintTargets(tree, changed, ''), 'lint of the sketch test files, no --fix,', where)
  })() }
  if (changed.some(file => ATTACH_CARRIER_SOURCES.some(source => file.startsWith(source)))) {
    yield { name: 'P9 carriers', commands: (function* (): Commands<void> {
      refuse('P9', greenRefusal('earlier-carriers --check', { criterion: 'the known set', command: EARLIER_CARRIERS_CHECK }, yield EARLIER_CARRIERS_CHECK, where))
    })() }
  }
}

function runCommands(commands: Commands<void>, shell: (command: string) => ShellResult): void {
  let step = commands.next()
  while (!step.done)
    step = commands.next(shell(step.value))
}

async function runCommandsAsync(commands: Commands<void>, shell: (command: string) => Promise<ShellResult>): Promise<void> {
  let step = commands.next()
  while (!step.done)
    step = commands.next(await shell(step.value))
}

export function runOnTree(run: TreeRun, task: TreeTask): void {
  for (const { name, commands } of treePhases(run, task))
    run.time(name, () => runCommands(commands, command => run.shell(command, run.tree)))
}

export async function runOnTreeAsync(run: AsyncTreeRun, task: TreeTask): Promise<void> {
  for (const { name, commands } of treePhases(run, task)) {
    run.phase?.(name)
    await runCommandsAsync(commands, command => run.shell(command, run.tree))
  }
}

export interface TestRunner {
  runs: (command: string) => boolean
  ranNoTests: (output: string) => boolean
  isTestFile: (file: string) => boolean
  retargeted: (command: string, files: readonly string[]) => string | null
}

const VITEST_NO_TEST = /No test files found|matched no test/
const VITEST_INVOCATION = /^\S.*?\bvitest\b(?:\s+run\b)?/
const RUN_VERB = ' run'

function unjudgedRun(command: string): string {
  return unjudgedCommand(command).trim().replace(NEGATION, '').trim()
}

const VITEST_RUNNER: TestRunner = {
  runs: command => VITEST.test(command),
  ranNoTests: output => VITEST_NO_TEST.test(output),
  isTestFile: file => TEST_FILE.test(file),
  retargeted: (command, files) => {
    const invocation = VITEST_INVOCATION.exec(unjudgedRun(command))?.[0]
    if (invocation === undefined)
      return null
    return [invocation.endsWith(RUN_VERB) ? invocation : `${invocation}${RUN_VERB}`, ...files].join(' ')
  },
}

const TEST_RUNNERS: readonly TestRunner[] = [VITEST_RUNNER]

function testRunnerOf(command: string): TestRunner | null {
  return TEST_RUNNERS.find(runner => runner.runs(command)) ?? null
}

export interface ReplacementField { id: string, run: string, test: null, head: 'pass', base: 'fail', proves: string }

export interface CardScope { touches: string[], creates: string[] }

export function cardScopeOfAdmitted(cardId: number, text: string, creates: readonly string[]): CardScope | null {
  const { touches } = admittedReachOf(cardId, text)
  return touches.length === 0 ? null : { touches, creates: [...creates] }
}

const NOT_A_PLAIN_PATH = /[:*?$`]/
const SCOPE_GLOB_TAIL = /\/\*\*$/

function namedPaths(command: string): string[] {
  const named = pathsNamedBy(unjudgedRun(command), token => token.includes('/') && !NOT_A_PLAIN_PATH.test(token))
  return [...new Set(named.map(token => token.replace(TRAILING_SLASHES, '')))]
}

function withinScope(file: string, scope: readonly string[]): boolean {
  return scope.some((entry) => {
    const root = entry.replace(SCOPE_GLOB_TAIL, '').replace(TRAILING_SLASHES, '')
    return file === root || file.startsWith(`${root}/`) || root.startsWith(`${file}/`)
  })
}

export function namedOutsideTheCard(tree: string, witness: Witness, scope: CardScope | null, changed: readonly string[]): string[] {
  if (scope === null)
    return []
  const card = [...scope.touches, ...scope.creates, ...changed]
  return namedPaths(witness.onBase?.command ?? witness.command).filter(file => !existsSync(path.join(tree, file)) && !withinScope(file, card))
}

export function ranNoTests(command: string, output: string): boolean {
  return testRunnerOf(command)?.ranNoTests(output) === true
}

export interface RedOnMainProposal { replacement: ReplacementField[] | null, files: string[] }

const RENDERED_ID = /^(W[1-9]\d*): /

function witnessIdOf(witness: Witness, witnesses: readonly Witness[]): string {
  return RENDERED_ID.exec(witness.criterion.trim())?.[1] ?? `W${witnesses.indexOf(witness) + 1}`
}

export function redOnMainProposal(unfit: readonly Witness[], witnesses: readonly Witness[], changed: readonly string[]): RedOnMainProposal {
  const runnable = [...unfit, ...witnesses].flatMap((witness) => {
    const runner = testRunnerOf(witness.command)
    return runner === null ? [] : [{ runner, command: witness.command }]
  })[0]
  if (runnable === undefined || unfit.length === 0)
    return { replacement: null, files: [] }
  const files = changed.filter(file => runnable.runner.isTestFile(file))
  const run = files.length === 0 ? null : runnable.runner.retargeted(runnable.command, files)
  const replacement: ReplacementField | null = run === null ? null : { id: witnessIdOf(unfit[0]!, witnesses), run, test: null, head: 'pass', base: 'fail', proves: `the card's own tests ${files.join(', ')} fail on main and pass on its head` }
  return { replacement: replacement === null ? null : [replacement], files }
}

import type { SpawnSyncReturns } from 'node:child_process'
import type { LayerMap } from '../core/layer-map.js'
import type { BranchCardRuns, BranchTests, CardLayers } from './card-runs.js'
import type { GateMode, GateRun } from './gate-runs.js'
import type { Graph, LayeredRun, Run } from './layers.js'
import type { Capability, SandboxFailing } from './sandbox-failing.js'
import type { Stale } from './sandbox-liveness.js'
import type { GateBase, Git, GreenRuns } from './select.js'
import type { VitestRun } from './test-command.js'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { testFoldersOfLayers } from '../cli/check-catalog.js'
import { readLayerMap } from '../core/layer-map.js'
import { pnpmCommand } from '../core/owner-commands.js'
import { withinTouches } from '../policy/touch-scope.js'
import { GhCiRuns } from '../ports/ci-reading.js'
import { processGit } from '../ports/git.js'
import { heavyStep } from '../quality/lock.js'
import { branchCardRuns } from './card-runs.js'
import { GATE_RUN_SPOOL, modeOfArgs, recordGateRun, sourceOf, touchesModuleFiles } from './gate-runs.js'
import { isTest, NARROW_WHY, narrowRun, sessionRun } from './layers.js'
import { CAPABILITIES, normLine, probeCapabilities, SANDBOX_FAILING, sandboxNorm } from './sandbox-failing.js'
import { listedFiles, livenessApplies, runTraced, staleInSandbox, staleLines } from './sandbox-liveness.js'
import { cruise, lastGreenMain, readTest, runSummary } from './select.js'
import { PASS_WITH_NO_TESTS, REPO_ROOT, RETRY, runVitest } from './test-command.js'
import { outcomesOf, testKey } from './vitest-report.js'

export const CI_DIFF = ['diff', '--name-only', '--no-renames', '-z']
export const PREPUSH_COMMAND = pnpmCommand('exec', 'node', '--import', 'tsx', 'scripts/ci/prepush.ts')
export const ROUND_FLAG = '--round'
export const LINT_COMMAND = pnpmCommand('lint')
const ESLINT_BIN = path.join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')
const LINT_FOUND_PROBLEMS = 1

export type Verdict
  = | { kind: 'green', ran: number }
    | { kind: 'red', failed: string[] }
    | { kind: 'broken', why: string }

export interface Gate { lines: string[], code: number }

const RAN = new Set(['passed', 'failed'])

export function withCardRuns(run: LayeredRun, reading: CardLayers | null, graph: Graph): LayeredRun {
  if (reading === null)
    return run
  const added = [...graph.keys()].filter(test => isTest(test) && withinTouches(test, reading.tests))
  return { kind: 'layers', layers: [...new Set([...run.layers, ...reading.layers])].sort(), tests: [...new Set([...run.tests, ...added])].sort() }
}

export function testsOfBranch(graph: Graph, folders: BranchTests['folders']): BranchTests {
  return { tests: [...graph.keys()].filter(isTest), folders }
}

export type BranchCard = Extract<BranchCardRuns, { kind: 'card' }>

function cardOfBranch(read: Git, graph: Graph): BranchCard | null {
  const found = branchCardRuns(read(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), undefined, testsOfBranch(graph, testFoldersOfLayers(readLayerMap())))
  if (found.kind === 'unreadable')
    console.log(`prepush: the card of the branch could not be read, the selection stays the changed paths': ${found.why}`)
  return found.kind === 'card' ? found : null
}

export function ciArgs(run: Run): string[] {
  return run.kind === 'layers' ? [...run.tests, PASS_WITH_NO_TESTS, RETRY] : [RETRY]
}

export function leftOut(run: Run, list: readonly SandboxFailing[]): SandboxFailing[] {
  return list.filter(entry => entry.test !== '' || run.kind === 'full' || run.tests.includes(entry.file))
}

function literal(name: string): string {
  return name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function sessionArgs(run: Run, list: readonly SandboxFailing[]): string[] {
  const out = leftOut(run, list)
  const files = out.filter(entry => entry.test === '').flatMap(entry => ['--exclude', entry.file])
  const names = [...new Set(out.filter(entry => entry.test !== '').map(entry => literal(entry.test)))]
  return [...ciArgs(run), ...files, ...(names.length === 0 ? [] : ['-t', `^(?!(?:${names.join('|')})$)`])]
}

export function testsVerdict(run: VitestRun, root = REPO_ROOT): Verdict {
  if (run.error !== null)
    return { kind: 'broken', why: `the test command did not start: ${run.error}` }
  if (run.report === null)
    return { kind: 'broken', why: `the test command exited ${run.status} and wrote no report` }
  const outcomes = outcomesOf(run.report, root)
  const failed = outcomes.filter(outcome => outcome.state === 'failed').map(outcome => testKey(outcome.file, outcome.name))
  if (failed.length > 0)
    return { kind: 'red', failed }
  if (run.status !== 0)
    return { kind: 'broken', why: `the test command exited ${run.status} with no failed test in its report` }
  return { kind: 'green', ran: outcomes.filter(outcome => RAN.has(outcome.state)).length }
}

function brokenGate(why: string): Gate {
  return {
    lines: [
      'prepush: broken — the push does not happen.',
      `finding: the pre-push test command is broken: ${why}`,
      `question: the pre-push test command cannot run in the card session (${why}); the owner decides whether the command or the session is repaired — the card does not repair product code to get past it.`,
    ],
    code: 2,
  }
}

export interface Selection {
  changed: readonly string[]
  run: LayeredRun
  why: string
  reach?: number | null
}

export function sessionSelection(changed: readonly string[], graph: Graph, testText: (test: string) => string, reading: CardLayers | null, map?: LayerMap): Selection {
  const session = sessionRun(changed, graph, testText, map)
  return { changed, run: withCardRuns(session.run, reading, graph), why: session.why }
}

export function reachCount(reach: () => Selection): number | null {
  try {
    return reach().run.tests.length
  }
  catch {
    return null
  }
}

export function narrowSelection(changed: readonly string[], graph: Graph, witnesses: readonly string[], reach: number | null, map?: LayerMap): Selection {
  return { changed, run: narrowRun(changed, graph, witnesses, map), why: NARROW_WHY, reach }
}

export function gateSelection(changed: readonly string[], graph: Graph, card: Pick<BranchCard, 'reading' | 'witnesses'> | null, testText: (test: string) => string = readTest, map?: LayerMap): Selection {
  const reach = reachCount(() => sessionSelection(changed, graph, testText, card?.reading ?? null, map))
  return narrowSelection(changed, graph, card?.witnesses ?? [], reach, map)
}

export function reachLine(narrow: number, reach: number | null): string {
  const would = reach === null ? 'the reach selection could not be counted' : `the reach selection would have picked ${reach}`
  return `prepush: the narrow selection picked ${narrow} test files; ${would}.`
}

export const NO_TESTS: Verdict = { kind: 'green', ran: 0 }

export function roundTests(run: Run, vitest: () => VitestRun): Verdict {
  return run.kind === 'layers' && run.tests.length === 0 ? NO_TESTS : testsVerdict(vitest())
}

export const FULL_RUN_IS_CI = 'the full suite is CI\'s, and the merge waits for its green run'

export function greenLine(ran: number): string {
  return `prepush: green — ${ran} tests of the session selection ran; ${FULL_RUN_IS_CI}; the push may go.`
}

export const SANDBOX_NORM_LINE = `prepush: green apart from sandbox norm; ${FULL_RUN_IS_CI}; the push may go.`

const EVERY_CAPABILITY: ReadonlySet<Capability> = new Set(CAPABILITIES)

export interface Suite {
  vitest: (args: readonly string[]) => VitestRun
  liveness: () => Stale[] | null
  queue: (step: () => Promise<number>) => Promise<number>
  log: (line: string) => void
  capabilities?: () => Promise<ReadonlySet<Capability>>
  record?: (ran: GateOutcome) => void
}

export type GateOutcome = Pick<GateRun, 'mode' | 'reason' | 'seconds' | 'tests'>

export async function testStep(selection: Selection, suite: Suite): Promise<number> {
  const { changed, run, why } = selection
  suite.log(`prepush: the gate runs ${why}; ${FULL_RUN_IS_CI}.`)
  suite.log(selection.reach === undefined ? runSummary(run) : reachLine(run.tests.length, selection.reach))
  return throughQueue(run, async () => {
    const started = Date.now()
    let ran: string[] | null = null
    const verdict = roundTests(run, () => suite.vitest(ran = sessionArgs(run, SANDBOX_FAILING)))
    const available = verdict.kind === 'red' ? await (suite.capabilities ?? probeCapabilities)() : EVERY_CAPABILITY
    const gate = prepushGate(changed, () => verdict, suite.liveness, available)
    const seconds = Math.round((Date.now() - started) / 1000)
    suite.log([...gate.lines, `prepush: ${seconds} s of local tests`].join('\n'))
    const mode: GateMode = modeOfArgs(ran)
    suite.record?.({ mode, reason: why, seconds, tests: run.tests.length })
    return gate.code
  }, suite.queue)
}

export function prepushGate(changed: readonly string[], tests: () => Verdict, liveness: () => Stale[] | null, available: ReadonlySet<Capability> = EVERY_CAPABILITY): Gate {
  const verdict = tests()
  if (verdict.kind === 'broken')
    return brokenGate(verdict.why)
  const reading = verdict.kind === 'red' ? sandboxNorm(verdict.failed, available) : null
  if (reading !== null && reading.real.length > 0)
    return { lines: ['prepush: red — the push does not happen; fix these in this session and run the gate again:', ...reading.real.map(key => `failed: ${key}`), ...reading.norm.map(normLine)], code: 1 }
  const normLines = reading === null ? [] : ['prepush: the only reds are sandbox norm — each test declares a capability this sandbox lacks, so it is red on main here too; another run changes nothing, and CI runs them:', ...reading.norm.map(normLine)]
  if (livenessApplies(changed)) {
    const stale = liveness()
    if (stale === null)
      return brokenGate('the sandbox liveness run wrote no report')
    if (stale.length > 0)
      return { lines: ['prepush: red — this change touches the sandbox list or the selector, and the liveness check is red; the push does not happen:', ...staleLines(stale)], code: 1 }
  }
  return { lines: [...normLines, verdict.kind === 'green' ? greenLine(verdict.ran) : SANDBOX_NORM_LINE], code: 0 }
}

export type { Git } from './select.js'

function git(args: readonly string[]): string {
  return processGit.read(REPO_ROOT, args)
}

export function cleanTreeGate(read: Git): Gate | null {
  const dirty = read(['status', '--porcelain']).trim() !== ''
  const allPushed = read(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']).trim() === '0'
  return dirty || !allPushed ? null : { lines: ['prepush: clean — the tree holds no change and no unpushed commit; no check started.'], code: 0 }
}

export function throughQueue(run: Run, step: () => Promise<number>, queue: (step: () => Promise<number>) => Promise<number> = heavyStep): Promise<number> {
  return run.kind === 'full' ? queue(step) : step()
}

export function roundOf(argv: readonly string[]): string | null {
  const at = argv.indexOf(ROUND_FLAG)
  if (at === -1)
    return null
  const head = argv[at + 1]
  if (head === undefined || head.startsWith('-'))
    throw new Error(`${ROUND_FLAG} names no head the round started on`)
  return head
}

export function gateBase(read: Git, round: string | null, ci: GreenRuns): GateBase {
  return round === null ? lastGreenMain(read, ci) : { sha: round, why: 'the head the round started on' }
}

export function changesSince(read: Git, base: string): string[] {
  const paths = [...read([...CI_DIFF, base]).split('\0'), ...read(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')]
  return [...new Set(paths.filter(entry => entry !== ''))].sort()
}

export function roundGate(prepush: readonly string[], head: string): string[] {
  if (!prepush.includes(PREPUSH_COMMAND))
    return [...prepush]
  return prepush.filter(command => command !== LINT_COMMAND).map(command => command === PREPUSH_COMMAND ? `${PREPUSH_COMMAND} ${ROUND_FLAG} ${head}` : command)
}

export function roundLintArgs(changed: readonly string[], exists: (file: string) => boolean): string[] {
  return changed.filter(file => exists(path.join(REPO_ROOT, file)))
}

export function lintGate(files: readonly string[], lint: (files: readonly string[]) => SpawnSyncReturns<string>): Gate | null {
  if (files.length === 0)
    return null
  const run = lint(files)
  if (run.error !== undefined)
    return brokenGate(`the round's lint did not start: ${run.error.message}`)
  if (run.status === 0)
    return null
  if (run.status === LINT_FOUND_PROBLEMS)
    return { lines: ['prepush: red — lint over the files this round changed found problems; fix them in this session and run the gate again:', run.stdout.trim()], code: 1 }
  return brokenGate(`the round's lint exited ${run.status}: ${run.stderr.trim()}`)
}

function eslint(files: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [ESLINT_BIN, '--no-warn-ignored', ...files], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function sandboxLiveness(): Stale[] | null {
  const traced = runTraced(listedFiles(SANDBOX_FAILING))
  return traced === null ? null : staleInSandbox(SANDBOX_FAILING, traced.outcomes, traced.traced)
}

export function gateRecorder(round: string | null, head: string, card: BranchCard | null, record: (run: GateRun) => void): (ran: GateOutcome) => void {
  return ran => record({ ...ran, source: sourceOf(round), round: round ?? head, card: card?.card ?? null, moduleFiles: touchesModuleFiles(card?.touches ?? []) })
}

export function sessionRecord(log: (line: string) => void, root: string = REPO_ROOT, busPath?: string): (run: GateRun) => void {
  const spool = path.join(root, GATE_RUN_SPOOL)
  return run => log(recordGateRun(run, new Date().toISOString(), busPath, spool))
}

export interface PrepushParts {
  argv: readonly string[]
  git: Git
  ci: GreenRuns
  cruise: () => Graph
  card: (read: Git, graph: Graph) => BranchCard | null
  testText: (test: string) => string
  exists: (file: string) => boolean
  lint: (files: readonly string[]) => SpawnSyncReturns<string>
  suite: Omit<Suite, 'log' | 'record'>
  log: (line: string) => void
  root: string
  busPath?: string
  map?: LayerMap
}

export async function prepush(parts: PrepushParts): Promise<number> {
  let selection: Selection
  let round: string | null
  let card: BranchCard | null
  let head: string
  try {
    round = roundOf(parts.argv)
    const clean = cleanTreeGate(parts.git)
    if (clean !== null) {
      parts.log(clean.lines.join('\n'))
      return clean.code
    }
    const base = gateBase(parts.git, round, parts.ci)
    parts.log(`prepush: the diff from ${base.why}`)
    const changed = changesSince(parts.git, base.sha)
    const graph: Graph = changed.length === 0 ? new Map() : parts.cruise()
    card = parts.card(parts.git, graph)
    selection = gateSelection(changed, graph, card, parts.testText, parts.map)
    head = parts.git(['rev-parse', 'HEAD']).trim()
  }
  catch (error) {
    parts.log(brokenGate(`the CI selector did not run: ${error instanceof Error ? error.message : String(error)}`).lines.join('\n'))
    return 2
  }
  parts.log(`prepush: ${selection.changed.length} changed paths`)
  if (round !== null) {
    const linted = lintGate(roundLintArgs(selection.changed, parts.exists), parts.lint)
    if (linted !== null) {
      parts.log(linted.lines.join('\n'))
      return linted.code
    }
  }
  const record = gateRecorder(round, head, card, sessionRecord(parts.log, parts.root, parts.busPath))
  return testStep(selection, { ...parts.suite, log: parts.log, record })
}

function processParts(): PrepushParts {
  return {
    argv: process.argv.slice(2),
    git,
    ci: new GhCiRuns(),
    cruise,
    card: cardOfBranch,
    testText: readTest,
    exists: existsSync,
    lint: eslint,
    suite: { vitest: args => runVitest(args), liveness: sandboxLiveness, queue: heavyStep },
    log: line => console.log(line),
    root: REPO_ROOT,
  }
}

if (process.argv[1] === import.meta.filename)
  process.exitCode = await prepush(processParts())

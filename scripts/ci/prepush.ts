import type { SpawnSyncReturns } from 'node:child_process'
import type { CardRuns } from './card-runs.js'
import type { Graph, Run } from './layers.js'
import type { SandboxFailing } from './sandbox-failing.js'
import type { Stale } from './sandbox-liveness.js'
import type { VitestRun } from './test-command.js'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { withinTouches } from '../../src/card/covering-tests.js'
import { heavyStep } from '../quality/lock.js'
import { branchCardRuns } from './card-runs.js'
import { isTest, reverseGraph, selectRun } from './layers.js'
import { SANDBOX_FAILING } from './sandbox-failing.js'
import { listedFiles, livenessApplies, runTraced, staleInSandbox, staleLines } from './sandbox-liveness.js'
import { cruise, readTest, reportedRun, runSummary } from './select.js'
import { PASS_WITH_NO_TESTS, REPO_ROOT, RETRY, runVitest } from './test-command.js'
import { outcomesOf, testKey } from './vitest-report.js'

export const CI_DIFF = ['diff', '--name-only', '--no-renames', '-z']
export const PREPUSH_COMMAND = 'pnpm exec node --import tsx scripts/ci/prepush.ts'
export const ROUND_FLAG = '--round'
export const LINT_COMMAND = 'pnpm lint'
const ESLINT_BIN = path.join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')
const LINT_FOUND_PROBLEMS = 1

export type Verdict
  = | { kind: 'green', ran: number }
    | { kind: 'red', failed: string[] }
    | { kind: 'broken', why: string }

export interface Gate { lines: string[], code: number }

const RAN = new Set(['passed', 'failed'])

export function withCardRuns(run: Run, reading: CardRuns | null, graph: Graph): Run {
  if (reading === null || run.kind === 'full')
    return run
  if ('full' in reading)
    return { kind: 'full', why: `the card of the branch reads in full: ${reading.why}` }
  const added = [...graph.keys()].filter(test => isTest(test) && withinTouches(test, reading.tests))
  return { kind: 'layers', layers: [...new Set([...run.layers, ...reading.layers])].sort(), tests: [...new Set([...run.tests, ...added])].sort() }
}

function readingOfBranch(read: Git): CardRuns | null {
  const found = branchCardRuns(read(['rev-parse', '--abbrev-ref', 'HEAD']).trim())
  if (found.kind === 'unreadable')
    console.log(`prepush: the card of the branch could not be read, the selection stays the changed paths': ${found.why}`)
  return found.kind === 'card' ? found.reading : null
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

export function roundRun(run: Run, changed: readonly string[], graph: Graph, select: (files: readonly string[]) => Run): Run {
  if (run.kind !== 'full')
    return run
  const reverse = reverseGraph(graph)
  const layers = new Set<string>()
  const tests = new Set<string>()
  for (const file of changed) {
    const one = select([file])
    if (one.kind === 'layers') {
      one.layers.forEach(layer => layers.add(layer))
      one.tests.forEach(test => tests.add(test))
    }
    else {
      testsReaching(file, reverse).forEach(test => tests.add(test))
    }
  }
  return { kind: 'layers', layers: [...layers].sort(), tests: [...tests].sort() }
}

function testsReaching(file: string, reverse: ReadonlyMap<string, readonly string[]>): string[] {
  const seen = new Set([file])
  const queue = [file]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const from of reverse.get(next) ?? []) {
      if (!seen.has(from)) {
        seen.add(from)
        queue.push(from)
      }
    }
  }
  return [...seen].filter(isTest)
}

export const NO_TESTS: Verdict = { kind: 'green', ran: 0 }

export function roundTests(run: Run, vitest: () => VitestRun): Verdict {
  return run.kind === 'layers' && run.tests.length === 0 ? NO_TESTS : testsVerdict(vitest())
}

export function greenLine(ran: number, round: string | null): string {
  return round === null
    ? `prepush: green — ${ran} tests ran; the push may go.`
    : `prepush: green — ${ran} tests of the layers this round reaches ran; the full suite is CI's, and the merge waits for its green run; the push may go.`
}

export interface Suite {
  vitest: (args: readonly string[]) => VitestRun
  liveness: () => Stale[] | null
  queue: (step: () => Promise<number>) => Promise<number>
  log: (line: string) => void
}

export async function testStep(changed: readonly string[], selected: Run, round: string | null, graph: Graph, select: (files: readonly string[]) => Run, suite: Suite): Promise<number> {
  const run = round === null ? selected : roundRun(selected, changed, graph, select)
  if (run !== selected)
    suite.log(`prepush: the round runs only the layers its change reaches (${selected.kind === 'full' ? selected.why : 'layered'}); the full suite is CI's.`)
  suite.log(runSummary(run))
  return throughQueue(run, async () => {
    const started = Date.now()
    const gate = prepushGate(changed, () => roundTests(run, () => suite.vitest(sessionArgs(run, SANDBOX_FAILING))), suite.liveness, round)
    suite.log([...gate.lines, `prepush: ${Math.round((Date.now() - started) / 1000)} s of local tests`].join('\n'))
    return gate.code
  }, suite.queue)
}

export function prepushGate(changed: readonly string[], tests: () => Verdict, liveness: () => Stale[] | null, round: string | null = null): Gate {
  const verdict = tests()
  if (verdict.kind === 'broken')
    return brokenGate(verdict.why)
  if (verdict.kind === 'red')
    return { lines: ['prepush: red — the push does not happen; fix these in this session and run the gate again:', ...verdict.failed.map(key => `failed: ${key}`)], code: 1 }
  if (livenessApplies(changed)) {
    const stale = liveness()
    if (stale === null)
      return brokenGate('the sandbox liveness run wrote no report')
    if (stale.length > 0)
      return { lines: ['prepush: red — this change touches the sandbox list or the selector, and the liveness check is red; the push does not happen:', ...staleLines(stale)], code: 1 }
  }
  return { lines: [greenLine(verdict.ran, round)], code: 0 }
}

export type Git = (args: readonly string[]) => string

function git(args: readonly string[]): string {
  const run = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (run.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
  return run.stdout
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

export function changesSince(read: Git, round: string | null): string[] {
  const base = round ?? read(['merge-base', 'HEAD', 'origin/main']).trim()
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

async function main(): Promise<number> {
  let changed: string[]
  let run: Run
  let round: string | null
  let graph: Graph
  try {
    round = roundOf(process.argv.slice(2))
    const clean = cleanTreeGate(git)
    if (clean !== null) {
      console.log(clean.lines.join('\n'))
      return clean.code
    }
    changed = changesSince(git, round)
    graph = changed.length === 0 ? new Map() : cruise()
    run = reportedRun(withCardRuns(selectRun(changed, graph, readTest), readingOfBranch(git), graph))
  }
  catch (error) {
    console.log(brokenGate(`the CI selector did not run: ${error instanceof Error ? error.message : String(error)}`).lines.join('\n'))
    return 2
  }
  if (round !== null) {
    console.log(`prepush: the round's diff from ${round}: ${changed.length} paths`)
    const linted = lintGate(roundLintArgs(changed, existsSync), eslint)
    if (linted !== null) {
      console.log(linted.lines.join('\n'))
      return linted.code
    }
  }
  return testStep(changed, run, round, graph, files => selectRun(files, graph, readTest), { vitest: args => runVitest(args), liveness: sandboxLiveness, queue: heavyStep, log: line => console.log(line) })
}

if (process.argv[1] === import.meta.filename)
  process.exitCode = await main()

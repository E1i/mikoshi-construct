import type { SpawnSyncReturns } from 'node:child_process'
import type { Run } from './layers.js'
import type { SandboxFailing } from './sandbox-failing.js'
import type { Stale } from './sandbox-liveness.js'
import type { VitestRun } from './test-command.js'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { selectRun } from './layers.js'
import { SANDBOX_FAILING, SANDBOX_FAILING_LIST } from './sandbox-failing.js'
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
const SANDBOX_LIST = path.relative(REPO_ROOT, SANDBOX_FAILING_LIST)

export type Verdict
  = | { kind: 'green', ran: number }
    | { kind: 'red', failed: string[], stale: string[] }
    | { kind: 'broken', why: string }

export interface Gate { lines: string[], code: number }

const RAN = new Set(['passed', 'failed'])

export function ciArgs(run: Run): string[] {
  return run.kind === 'layers' ? [...run.tests, PASS_WITH_NO_TESTS, RETRY] : [RETRY]
}

export function sessionArgs(run: Run, list: readonly SandboxFailing[]): string[] {
  const files = list.filter(entry => entry.test === '' && (run.kind === 'full' || run.tests.includes(entry.file)))
  return [...ciArgs(run), ...files.flatMap(entry => ['--exclude', entry.file])]
}

export function testsVerdict(run: VitestRun, list: readonly SandboxFailing[], root = REPO_ROOT): Verdict {
  if (run.error !== null)
    return { kind: 'broken', why: `the test command did not start: ${run.error}` }
  if (run.report === null)
    return { kind: 'broken', why: `the test command exited ${run.status} and wrote no report` }
  const outcomes = outcomesOf(run.report, root)
  const listed = new Set(list.map(entry => testKey(entry.file, entry.test)))
  const keyed = outcomes.map(outcome => ({ state: outcome.state, key: testKey(outcome.file, outcome.name) }))
  const failed = keyed.filter(outcome => outcome.state === 'failed' && !listed.has(outcome.key)).map(outcome => outcome.key)
  const stale = keyed.filter(outcome => outcome.state === 'passed' && listed.has(outcome.key)).map(outcome => outcome.key)
  if (failed.length > 0 || stale.length > 0)
    return { kind: 'red', failed, stale }
  if (run.status !== 0 && !keyed.some(outcome => outcome.state === 'failed'))
    return { kind: 'broken', why: `the test command exited ${run.status} with no failed test in its report` }
  return { kind: 'green', ran: keyed.filter(outcome => RAN.has(outcome.state)).length }
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

export function prepushGate(changed: readonly string[], tests: () => Verdict, liveness: () => Stale[] | null): Gate {
  const verdict = tests()
  if (verdict.kind === 'broken')
    return brokenGate(verdict.why)
  if (verdict.kind === 'red')
    return { lines: ['prepush: red — the push does not happen; fix these in this session and run the gate again:', ...verdict.failed.map(key => `failed: ${key}`), ...verdict.stale.map(key => `stale: ${key} — passes in the session sandbox, so its entry in ${SANDBOX_LIST} is stale`)], code: 1 }
  if (livenessApplies(changed)) {
    const stale = liveness()
    if (stale === null)
      return brokenGate('the sandbox liveness run wrote no report')
    if (stale.length > 0)
      return { lines: ['prepush: red — this change touches the sandbox list or the selector, and the liveness check is red; the push does not happen:', ...staleLines(stale)], code: 1 }
  }
  return { lines: [`prepush: green — ${verdict.ran} tests ran; the push may go.`], code: 0 }
}

export type Git = (args: readonly string[]) => string

function git(args: readonly string[]): string {
  const run = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (run.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
  return run.stdout
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

function main(): number {
  let changed: string[]
  let run: Run
  let round: string | null
  try {
    round = roundOf(process.argv.slice(2))
    changed = changesSince(git, round)
    run = reportedRun(changed.length === 0 ? selectRun([], new Map(), () => '') : selectRun(changed, cruise(), readTest))
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
  console.log(runSummary(run))
  const started = Date.now()
  const gate = prepushGate(changed, () => testsVerdict(runVitest(sessionArgs(run, SANDBOX_FAILING)), SANDBOX_FAILING), sandboxLiveness)
  console.log([...gate.lines, `prepush: ${Math.round((Date.now() - started) / 1000)} s of local tests`].join('\n'))
  return gate.code
}

if (process.argv[1] === import.meta.filename)
  process.exitCode = main()

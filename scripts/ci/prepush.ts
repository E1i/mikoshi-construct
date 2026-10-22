import type { Run } from './layers.js'
import type { SandboxFailing } from './sandbox-failing.js'
import type { Stale } from './sandbox-liveness.js'
import type { VitestRun } from './test-command.js'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { selectRun } from './layers.js'
import { SANDBOX_FAILING } from './sandbox-failing.js'
import { listedFiles, livenessApplies, runTraced, staleInSandbox, staleLines } from './sandbox-liveness.js'
import { cruise, readTest, reportedRun, runSummary } from './select.js'
import { PASS_WITH_NO_TESTS, REPO_ROOT, RETRY, runVitest } from './test-command.js'
import { outcomesOf, testKey } from './vitest-report.js'

export const CI_DIFF = ['diff', '--name-only', '--no-renames', '-z']
export const PREPUSH_COMMAND = 'pnpm exec node --import tsx scripts/ci/prepush.ts'

export type Verdict
  = | { kind: 'green', ran: number }
    | { kind: 'red', failed: string[] }
    | { kind: 'broken', why: string }

export interface Gate { lines: string[], code: number }

const RAN = new Set(['passed', 'failed'])

export function ciArgs(run: Run): string[] {
  return run.kind === 'layers' ? [...run.tests, PASS_WITH_NO_TESTS, RETRY] : [RETRY]
}

export function leftOut(run: Run, list: readonly SandboxFailing[]): SandboxFailing[] {
  return list.filter(entry => run.kind === 'full' || run.tests.includes(entry.file))
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

export function prepushGate(changed: readonly string[], tests: () => Verdict, liveness: () => Stale[] | null): Gate {
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
  return { lines: [`prepush: green — ${verdict.ran} tests ran; the push may go.`], code: 0 }
}

function git(args: readonly string[]): string {
  const run = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (run.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
  return run.stdout
}

export function sessionChanges(): string[] {
  const base = git(['merge-base', 'HEAD', 'origin/main']).trim()
  const paths = [...git([...CI_DIFF, base]).split('\0'), ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')]
  return [...new Set(paths.filter(entry => entry !== ''))].sort()
}

function sandboxLiveness(): Stale[] | null {
  const traced = runTraced(listedFiles(SANDBOX_FAILING))
  return traced === null ? null : staleInSandbox(SANDBOX_FAILING, traced.outcomes, traced.traced)
}

function main(): number {
  let changed: string[]
  let run: Run
  try {
    changed = sessionChanges()
    run = reportedRun(changed.length === 0 ? selectRun([], new Map(), () => '') : selectRun(changed, cruise(), readTest))
  }
  catch (error) {
    console.log(brokenGate(`the CI selector did not run: ${error instanceof Error ? error.message : String(error)}`).lines.join('\n'))
    return 2
  }
  console.log(runSummary(run))
  const started = Date.now()
  const gate = prepushGate(changed, () => testsVerdict(runVitest(sessionArgs(run, SANDBOX_FAILING))), sandboxLiveness)
  console.log([...gate.lines, `prepush: ${Math.round((Date.now() - started) / 1000)} s of local tests`].join('\n'))
  return gate.code
}

if (process.argv[1] === import.meta.filename)
  process.exitCode = main()

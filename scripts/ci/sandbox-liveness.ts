import type { SandboxFailing } from './sandbox-failing.js'
import type { TraceLine } from './sandbox-refusals.js'
import type { TestOutcome } from './vitest-report.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { SANDBOX_FAILING } from './sandbox-failing.js'
import { refusalsIn, SANDBOX_TRACE_VARIABLE } from './sandbox-refusals.js'
import { REPO_ROOT, runVitest } from './test-command.js'
import { outcomesOf, testKey } from './vitest-report.js'

export const SELECTOR_FILES = [
  'scripts/ci/layers.ts',
  'scripts/ci/prepush.ts',
  'scripts/ci/sandbox-failing.jsonl',
  'scripts/ci/sandbox-failing.ts',
  'scripts/ci/sandbox-trace-child.mjs',
  'scripts/ci/sandbox-liveness.ts',
  'scripts/ci/sandbox-refusals.ts',
  'scripts/ci/sandbox-trace.config.ts',
  'scripts/ci/sandbox-trace.ts',
  'scripts/ci/select.ts',
  'scripts/ci/test-command.ts',
  'scripts/ci/tree-scanners.ts',
  'scripts/ci/vitest-report.ts',
]

const TRACE_CONFIG = 'scripts/ci/sandbox-trace.config.ts'
const NAME_PLACEHOLDER = /%[sdifjoOc#]|\$[\w.]+/g

export interface Stale { entry: SandboxFailing, why: string }
export interface Collected { file: string, name: string }

export function livenessApplies(changed: readonly string[]): boolean {
  return changed.some(file => SELECTOR_FILES.includes(file))
}

export function refusalsOf(outcome: TestOutcome, traced: readonly TraceLine[]): string[] {
  const own = traced.filter(line => line.file === outcome.file && line.test === outcome.name)
  const lines = own.length > 0 ? own : traced.filter(line => line.file === outcome.file)
  return refusalsIn([...outcome.messages, ...lines.map(line => line.refused)].join('\n'))
}

export function staleInSandbox(list: readonly SandboxFailing[], outcomes: readonly TestOutcome[], traced: readonly TraceLine[]): Stale[] {
  return list.flatMap((entry) => {
    const outcome = outcomes.find(candidate => candidate.file === entry.file && candidate.name === entry.test)
    if (outcome === undefined)
      return [{ entry, why: `no longer runs: ${entry.file} has no test of that name` }]
    if (outcome.state !== 'failed')
      return [{ entry, why: `no longer fails in the session sandbox: it ${outcome.state}` }]
    if (!refusalsOf(outcome, traced).includes(entry.refused))
      return [{ entry, why: `still fails, but no longer on ${entry.refused}` }]
    return []
  })
}

function templateOf(name: string): RegExp {
  const escaped = name.split(NAME_PLACEHOLDER).map(part => part.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${escaped.join('.+')}$`)
}

export function missingInCi(list: readonly SandboxFailing[], collected: readonly Collected[]): Stale[] {
  return list
    .filter(entry => !collected.some(test => test.file === entry.file && (entry.test === '' || templateOf(test.name).test(entry.test))))
    .map(entry => ({ entry, why: 'is no longer collected by vitest, so CI no longer runs it' }))
}

export function staleLines(stale: readonly Stale[]): string[] {
  return stale.map(({ entry, why }) => `stale: ${testKey(entry.file, entry.test)} — ${why}`)
}

export function listedFiles(list: readonly SandboxFailing[]): string[] {
  return [...new Set(list.map(entry => entry.file))].sort()
}

function readTrace(file: string): TraceLine[] {
  if (!existsSync(file))
    return []
  return readFileSync(file, 'utf8').split('\n').filter(line => line !== '').map((line) => {
    const traced = JSON.parse(line) as TraceLine
    return { ...traced, file: path.relative(REPO_ROOT, traced.file) }
  })
}

export function runTraced(files: readonly string[]): { outcomes: TestOutcome[], traced: TraceLine[] } | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'sandbox-liveness-'))
  try {
    const trace = path.join(dir, 'trace.jsonl')
    const run = runVitest([...files, '--config', TRACE_CONFIG], { ...process.env, [SANDBOX_TRACE_VARIABLE]: trace })
    return run.report === null ? null : { outcomes: outcomesOf(run.report, REPO_ROOT), traced: readTrace(trace) }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function collectedInCi(files: readonly string[]): Collected[] | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'sandbox-list-'))
  try {
    const listed = path.join(dir, 'list.json')
    const run = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'list', '--staticParse=false', `--json=${listed}`, ...files], { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
    if (run.status !== 0 || !existsSync(listed))
      return null
    return (JSON.parse(readFileSync(listed, 'utf8')) as Collected[]).map(test => ({ file: path.relative(REPO_ROOT, test.file), name: test.name }))
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function probeLines(outcomes: readonly TestOutcome[], traced: readonly TraceLine[]): string[] {
  return outcomes.filter(outcome => outcome.state === 'failed').map((outcome) => {
    const refusals = refusalsOf(outcome, traced)
    const unread = [...traced.filter(line => line.file === outcome.file).map(line => line.refused), ...outcome.messages].join(' | ').slice(0, 400)
    return `${JSON.stringify({ file: outcome.file, test: outcome.name })}\t${refusals.join(', ') || `unknown: ${unread}`}`
  })
}

function main(): number {
  const mode = process.argv[2]
  if (mode === '--probe') {
    const traced = runTraced(process.argv.slice(3))
    console.log(traced === null ? 'the test command wrote no report' : probeLines(traced.outcomes, traced.traced).join('\n'))
    return traced === null ? 2 : 0
  }
  if (mode === '--ci') {
    const collected = collectedInCi(listedFiles(SANDBOX_FAILING))
    if (collected === null) {
      console.log('finding: vitest list did not run, so the liveness check cannot say what CI runs')
      return 2
    }
    const stale = missingInCi(SANDBOX_FAILING, collected)
    console.log([...staleLines(stale), `sandbox list: ${SANDBOX_FAILING.length - stale.length} of ${SANDBOX_FAILING.length} listed tests are still run in CI`].join('\n'))
    return stale.length === 0 ? 0 : 1
  }
  const traced = runTraced(listedFiles(SANDBOX_FAILING))
  if (traced === null) {
    console.log('finding: the liveness run wrote no report, so no listed test was checked')
    return 2
  }
  const stale = staleInSandbox(SANDBOX_FAILING, traced.outcomes, traced.traced)
  console.log([...staleLines(stale), `sandbox list: ${SANDBOX_FAILING.length - stale.length} of ${SANDBOX_FAILING.length} listed tests still fail in the session sandbox on their own refusal`].join('\n'))
  return stale.length === 0 ? 0 : 1
}

if (process.argv[1] === import.meta.filename)
  process.exitCode = main()

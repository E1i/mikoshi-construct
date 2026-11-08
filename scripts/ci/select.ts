import type { CiRuns } from '../ports/ci-reading.js'
import type { Graph, Run } from './layers.js'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { GhCiRuns } from '../ports/ci-reading.js'
import { selectRun, windowGate } from './layers.js'
import { livenessApplies } from './sandbox-liveness.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const DEPCRUISE = path.join(REPO_ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs')
const CRUISED = ['scripts', 'src', 'tests']
const CRUISE_BUFFER = 256 * 1024 * 1024

interface CruiseModule { source: string, dependencies: { resolved: string }[] }

export function graphOf(modules: readonly CruiseModule[]): Graph {
  return new Map(modules.map(module => [module.source, module.dependencies.map(dependency => dependency.resolved)]))
}

export function cruise(): Graph {
  const run = spawnSync(process.execPath, [DEPCRUISE, '--config', '.dependency-cruiser.mjs', '--output-type', 'json', ...CRUISED], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: CRUISE_BUFFER })
  if (run.stdout === '')
    throw new Error(`depcruise printed no result: ${run.stderr}`)
  return graphOf((JSON.parse(run.stdout) as { modules: CruiseModule[] }).modules)
}

export function runSummary(run: Run): string {
  if (run.kind === 'full')
    return `Full run: ${run.why}.`
  return [
    `Layers: ${run.layers.join(', ') || 'none'} — the touched layers and every layer that depends on them.`,
    `Tests: ${run.tests.length}; every other test file is skipped because it reaches no changed module.`,
  ].join('\n')
}

export function reportedRun(run: Run): Run {
  if (run.kind === 'layers' && run.tests.length === 0)
    return { kind: 'full', why: 'the touched layers reach no test file, and vitest given no file runs every test' }
  return run
}

export function pathsOf(args: readonly string[], stdin: () => string): string[] {
  if (!args.includes('--stdin'))
    return [...args]
  return [...args.filter(arg => arg !== '--stdin'), ...stdin().split('\0').filter(entry => entry !== '')]
}

export function outputLines(run: Run): string {
  const tests = run.kind === 'layers' ? run.tests.join(' ') : ''
  return `full=${run.kind === 'full'}\ntests=${tests}\n`
}

export function changedPathsOf(diff: string, untracked: string): string[] {
  return [...new Set([...diff.split('\n'), ...untracked.split('\n')].filter(entry => entry !== ''))].sort()
}

export function windowLines(run: Run): string {
  const tests = run.kind === 'layers' ? `pnpm exec vitest run ${run.tests.join(' ')}` : 'pnpm test'
  return `${runSummary(run)}\nWindow gate (D-194): the card's witnesses, then ${tests}, pnpm typecheck and pnpm lint, each as its own command.`
}

export type Git = (args: readonly string[]) => string

export type GreenRuns = Pick<CiRuns, 'successfulRunsOnMain'>

export interface GateBase { sha: string, why: string }

export const GREEN_RUNS_READ = 20

function inHistory(read: Git, sha: string): boolean {
  try {
    return read(['merge-base', sha, 'HEAD']).trim() === sha
  }
  catch {
    return false
  }
}

export function lastGreenMain(read: Git, ci: GreenRuns): GateBase {
  const mergeBase = read(['merge-base', 'HEAD', 'origin/main']).trim()
  const runs = ci.successfulRunsOnMain(GREEN_RUNS_READ)
  if (runs.kind === 'failed')
    return { sha: mergeBase, why: `the merge-base with origin/main, because the last green main could not be read: ${runs.reason}` }
  const green = runs.value.find(run => inHistory(read, run.headSha))
  if (green === undefined)
    return { sha: mergeBase, why: `the merge-base with origin/main, because none of the last ${GREEN_RUNS_READ} green main runs is in this branch's history` }
  return { sha: green.headSha, why: `the last main commit with green CI, ${green.headSha.slice(0, 7)} (run ${green.databaseId})` }
}

function git(args: readonly string[]): string {
  const run = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (run.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
  return run.stdout
}

function treeChanges(): string[] {
  const base = lastGreenMain(git, new GhCiRuns()).sha
  return changedPathsOf(git(['diff', '--name-only', base]), git(['ls-files', '--others', '--exclude-standard']))
}

export function readTest(test: string): string {
  return readFileSync(path.join(REPO_ROOT, test), 'utf8')
}

function windowMain(): void {
  const changed = treeChanges()
  console.log(windowLines(reportedRun(changed.length === 0 ? windowGate([], new Map(), () => '') : windowGate(changed, cruise(), readTest))))
}

function main(): void {
  if (process.argv.includes('--window'))
    return windowMain()
  const changed = pathsOf(process.argv.slice(2), () => readFileSync(0, 'utf8'))
  const run = reportedRun(changed.length === 0 ? selectRun([], new Map(), () => '') : selectRun(changed, cruise(), readTest))
  console.log(runSummary(run))
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputLines(run)}liveness=${livenessApplies(changed)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${runSummary(run)}\n`)
}

if (process.argv[1] === import.meta.filename)
  main()

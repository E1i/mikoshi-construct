import type { Graph, Run } from './layers.js'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { selectRun } from './layers.js'

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

export function pathsOf(args: readonly string[], stdin: () => string): string[] {
  if (!args.includes('--stdin'))
    return [...args]
  return [...args.filter(arg => arg !== '--stdin'), ...stdin().split('\0').filter(entry => entry !== '')]
}

function main(): void {
  const changed = pathsOf(process.argv.slice(2), () => readFileSync(0, 'utf8'))
  const run = changed.length === 0 ? selectRun([], new Map(), () => '') : selectRun(changed, cruise(), test => readFileSync(path.join(REPO_ROOT, test), 'utf8'))
  console.log(runSummary(run))
  if (process.env.GITHUB_OUTPUT) {
    const tests = run.kind === 'layers' ? run.tests.join(' ') : ''
    appendFileSync(process.env.GITHUB_OUTPUT, `full=${run.kind === 'full'}\ntests=${tests}\n`)
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${runSummary(run)}\n`)
}

if (process.argv[1] === import.meta.filename)
  main()

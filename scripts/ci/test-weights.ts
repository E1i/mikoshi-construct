import type { TestWeights } from './shard.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import config from '../../vitest.config.js'
import { execGh, readGhJson } from '../core/gh.js'
import { updateWeights, weightsFromVitestReport } from './shard.js'

export interface RunStep { name: string, startedAt: string, completedAt: string }
export interface RunJob { name: string, conclusion: string, startedAt: string, completedAt: string, steps?: RunStep[] }

export type SpreadVerdict
  = | { kind: 'not-proven', before: number[], after: number[], needed: number }
    | { kind: 'smaller' | 'not-smaller', before: number[], after: number[] }

export const MIN_RUNS_PER_SIDE = 3
export const RUNS_PER_SIDE = 6
export const CI_REPORT_ARTIFACT = 'vitest-report'
export const WEIGHTS_PATH = 'scripts/ci/test-weights.json'
const RUNS_LISTED = 60
const SHARD_JOB = /^vitest (\d+)\/(\d+)$/
const TEST_STEP = 'Run pnpm test'
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

const seconds = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 1000

export interface SpreadReading { testSet: string, shards: number, spread: number }

export function shardSpread(jobs: readonly RunJob[]): { shards: number, spread: number } | undefined {
  const shards = jobs.flatMap((job) => {
    const match = SHARD_JOB.exec(job.name)
    return match === null ? [] : [{ job, total: Number(match[2]) }]
  })
  const total = shards[0]?.total
  if (total === undefined || shards.length !== total || shards.some(shard => shard.total !== total || shard.job.conclusion !== 'success'))
    return undefined
  const durations = shards.map(({ job }) => {
    const step = job.steps?.find(candidate => candidate.name.startsWith(TEST_STEP))
    return step === undefined ? seconds(job.startedAt, job.completedAt) : seconds(step.startedAt, step.completedAt)
  })
  return { shards: total, spread: Math.max(...durations) - Math.min(...durations) }
}

export function testSetOf(files: readonly string[]): string {
  const included = (file: string): boolean => config.test!.include!.some(glob => path.matchesGlob(file, glob)) && !config.test!.exclude!.some(glob => path.matchesGlob(file, glob))
  return files.filter(included).sort().join('\n')
}

export function comparableSpreads(before: readonly SpreadReading[], after: readonly SpreadReading[], testSet: string): { before: number[], after: number[], excluded: number } {
  const shards = [...after, ...before].find(reading => reading.testSet === testSet)?.shards
  const comparable = (readings: readonly SpreadReading[]): number[] => readings.filter(reading => reading.testSet === testSet && reading.shards === shards).map(reading => reading.spread).slice(0, RUNS_PER_SIDE)
  const kept = { before: comparable(before), after: comparable(after) }
  return { ...kept, excluded: before.length + after.length - kept.before.length - kept.after.length }
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function compareSpreads(before: readonly number[], after: readonly number[], needed = MIN_RUNS_PER_SIDE): SpreadVerdict {
  if (before.length < needed || after.length < needed)
    return { kind: 'not-proven', before: [...before], after: [...after], needed }
  return { kind: median(after) < Math.min(...before) ? 'smaller' : 'not-smaller', before: [...before], after: [...after] }
}

export function spreadLines(verdict: SpreadVerdict, boundary: string): string[] {
  const side = (label: string, values: number[]): string => values.length === 0
    ? `${label}: no comparable run`
    : `${label}: ${values.length} runs, median ${median(values).toFixed(0)} s (${values.map(value => value.toFixed(0)).join(', ')})`
  const head = [`gap between the slowest and the fastest vitest shard on main, around ${boundary.slice(0, 12)}`, side('before', verdict.before), side('after', verdict.after)]
  if (verdict.kind === 'not-proven')
    return [...head, `not proven yet: ${MIN_RUNS_PER_SIDE} comparable runs are needed on each side, before has ${verdict.before.length}, after has ${verdict.after.length}`]
  return [...head, verdict.kind === 'smaller' ? 'smaller after: the median gap after is below every gap before' : 'not smaller after: the median gap after is not below every gap before']
}

function git(args: string[]): string | undefined {
  const run = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return run.status === 0 ? run.stdout.trim() : undefined
}

function failWith(line: string): never {
  console.error(line)
  process.exit(1)
}

function mainRuns(): { databaseId: number, headSha: string }[] {
  const listed = readGhJson<{ databaseId: number, headSha: string }[]>(execGh, ['run', 'list', '--workflow', 'CI', '--branch', 'main', '--event', 'push', '--status', 'success', '--limit', String(RUNS_LISTED), '--json', 'databaseId,headSha'])
  return listed.kind === 'read' ? listed.value : failWith(`test:weights: the CI runs on main could not be listed: ${listed.reason}`)
}

function spreadOnMain(boundaryArgument: string | undefined): void {
  const boundary = boundaryArgument ?? git(['log', '-1', '--format=%H', 'origin/main', '--', WEIGHTS_PATH]) ?? failWith(`test:weights: no commit on origin/main changes ${WEIGHTS_PATH}; fetch origin or pass --boundary <sha>`)
  const commits = (range: string): Set<string> => new Set((git(['rev-list', range]) ?? '').split('\n'))
  const after = commits(`${boundary}^..origin/main`)
  const earlier = commits(`${boundary}^`)
  const testSet = testSetOf((git(['ls-tree', '-r', '--name-only', boundary]) ?? '').split('\n'))
  const readings = { before: [] as SpreadReading[], after: [] as SpreadReading[] }
  let unknown = 0
  for (const run of mainRuns()) {
    const side = after.has(run.headSha) ? readings.after : earlier.has(run.headSha) ? readings.before : undefined
    if (side === undefined) {
      unknown += 1
      continue
    }
    if (side.filter(reading => reading.testSet === testSet).length >= RUNS_PER_SIDE)
      continue
    const runTestSet = testSetOf((git(['ls-tree', '-r', '--name-only', run.headSha]) ?? '').split('\n'))
    const jobs = readGhJson<{ jobs: RunJob[] }>(execGh, ['run', 'view', String(run.databaseId), '--json', 'jobs'])
    const reading = jobs.kind === 'read' ? shardSpread(jobs.value.jobs) : undefined
    if (reading !== undefined)
      side.push({ testSet: runTestSet, ...reading })
  }
  const comparable = comparableSpreads(readings.before, readings.after, testSet)
  const verdict = compareSpreads(comparable.before, comparable.after)
  console.log(spreadLines(verdict, boundary).join('\n'))
  if (comparable.excluded > 0)
    console.log(`${comparable.excluded} runs on main ran another test set or shard count than ${boundary.slice(0, 12)} and are not compared`)
  if (unknown > 0)
    console.log(`${unknown} runs on main are on commits this clone does not have and are not counted; git fetch origin main reads them`)
  process.exit(verdict.kind === 'smaller' ? 0 : 1)
}

function reportFromMain(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'test-weights-'))
  for (const run of mainRuns()) {
    if (execGh(['run', 'download', String(run.databaseId), '--name', CI_REPORT_ARTIFACT, '--dir', directory]).kind === 'ran')
      return path.join(directory, 'vitest.json')
  }
  return failWith(`test:weights: no successful push run on main carries the ${CI_REPORT_ARTIFACT} artifact; the table is left as it is`)
}

function readWeights(): TestWeights {
  const file = path.join(REPO_ROOT, WEIGHTS_PATH)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as TestWeights : {}
}

function rewriteFrom(report: string): void {
  const file = path.resolve(REPO_ROOT, report)
  if (!existsSync(file))
    failWith(`test:weights: no report at ${report}; the table is left as it is`)
  const onDisk = (test: string): boolean => test !== '' && existsSync(path.join(REPO_ROOT, test))
  const measured = weightsFromVitestReport(JSON.parse(readFileSync(file, 'utf8')), onDisk)
  if (Object.keys(measured).length === 0)
    failWith(`test:weights: ${report} measures no passed test file of this repository; the table is left as it is`)
  const previous = readWeights()
  const weights = updateWeights(previous, measured, onDisk)
  writeFileSync(path.join(REPO_ROOT, WEIGHTS_PATH), `${JSON.stringify(weights, null, 2)}\n`)
  const dropped = Object.keys(previous).filter(test => !(test in weights)).length
  console.log(`${WEIGHTS_PATH}: ${Object.keys(weights).length} files, ${Object.keys(measured).length} measured from ${report}, ${dropped} no longer on disk dropped`)
}

function main(argv: string[]): void {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name)
    return at === -1 ? undefined : argv[at + 1]
  }
  if (argv.includes('--spread'))
    return flag('--spread') === 'main' ? spreadOnMain(flag('--boundary')) : failWith('usage: pnpm test:weights --spread main [--boundary <sha>]')
  if (argv.includes('--from'))
    return flag('--from') === 'main' ? rewriteFrom(reportFromMain()) : failWith('usage: pnpm test:weights --from main')
  rewriteFrom(argv[0] ?? '.construct/reports/vitest.json')
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2))

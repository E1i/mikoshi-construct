import type { RunJob } from '../ports/ci-reading.js'
import type { TestWeights } from './shard.js'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import config from '../../vitest.config.js'
import { pnpmCommand } from '../core/owner-commands.js'
import { GhCiRuns, WEIGHTS_TABLE_PATH } from '../ports/ci-reading.js'
import { processGit } from '../ports/git.js'
import { FILE_WEIGHTS_NAME } from './file-weights-reporter.js'
import { balanceShards, MIN_WEIGHT, updateWeights, weightsFromFileWeights } from './shard.js'

export { FILE_WEIGHTS_NAME }
export type { CiRuns, RunJob, RunOnMain, RunStep } from '../ports/ci-reading.js'
export type { TestWeights } from './shard.js'

export type SpreadVerdict
  = | { kind: 'not-proven', before: number[], after: number[], needed: number }
    | { kind: 'smaller' | 'not-smaller', before: number[], after: number[] }

export const MIN_RUNS_PER_SIDE = 3
export const RUNS_PER_SIDE = 6
export const CI_REPORT_ARTIFACT = 'vitest-report'
export const JSON_REPORT_PATH = '.construct/reports/vitest.json'
export const FILE_WEIGHTS_PATH = path.join(path.dirname(JSON_REPORT_PATH), FILE_WEIGHTS_NAME)
export const WEIGHTS_PATH = WEIGHTS_TABLE_PATH
export const MAX_UNWEIGHTED_SHARE = 0.1
export const CI_SHARDS = 8
export const MAX_SHARD_IMBALANCE = 0.2
export const MAX_DRIFTED_SHARE = 0.05
export const RECOMPUTE_DRIFTED_SHARE = 0.3
export const MAX_WEIGHT_RATIO = 2
export const RECOMPUTE_COMMAND = pnpmCommand('test:weights', '--from', 'main')
const RUNS_LISTED = 60
const SHARD_JOB = /^vitest (\d+)\/(\d+)$/
const TEST_STEP = `Run ${pnpmCommand('test')}`
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const CI = new GhCiRuns()

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

export interface WeightsFreshness { tests: number, unweighted: string[], stale: boolean, line: string }

export function weightsFreshness(files: readonly string[], weights: TestWeights, threshold = MAX_UNWEIGHTED_SHARE): WeightsFreshness {
  const tests = testSetOf(files).split('\n').filter(file => file !== '')
  const unweighted = tests.filter(file => weights[file] === undefined)
  const share = tests.length === 0 ? 0 : unweighted.length / tests.length
  const stale = share > threshold
  const counted = `${unweighted.length} of ${tests.length} test files (${(share * 100).toFixed(1)}%) have no weight in ${WEIGHTS_PATH}`
  const line = stale
    ? `${counted}, above the ${(threshold * 100).toFixed(0)}% threshold; recompute the table with ${RECOMPUTE_COMMAND}`
    : `${counted}, within the ${(threshold * 100).toFixed(0)}% threshold`
  return { tests: tests.length, unweighted, stale, line }
}

export interface WeightsDrift { drifted: string[], driftedSeconds: number, longestShardSeconds: number, share: number, stale: boolean, line: string }

function driftsFrom(measuredSeconds: number, weight: number | undefined): boolean {
  if (weight === undefined)
    return true
  const held = Math.max(MIN_WEIGHT, weight)
  const measured = Math.max(MIN_WEIGHT, measuredSeconds)
  return measured > held * MAX_WEIGHT_RATIO || held > measured * MAX_WEIGHT_RATIO
}

export function weightsDrift(measured: TestWeights, weights: TestWeights, threshold = MAX_DRIFTED_SHARE): WeightsDrift {
  const files = Object.keys(measured)
  const secondsOf = (list: readonly string[]): number => list.reduce((sum, file) => sum + measured[file]!, 0)
  const longestShardSeconds = Math.max(0, ...balanceShards(files, weights, CI_SHARDS).map(secondsOf))
  const drifted = files.filter(file => driftsFrom(measured[file]!, weights[file])).sort()
  const driftedSeconds = secondsOf(drifted)
  const share = longestShardSeconds === 0 ? 0 : driftedSeconds / longestShardSeconds
  const stale = share > threshold
  const counted = `${drifted.length} measured test files with no weight or a weight more than ${MAX_WEIGHT_RATIO}x off in ${WEIGHTS_PATH} carry ${driftedSeconds.toFixed(1)} s, ${(share * 100).toFixed(1)}% of the longest shard's ${longestShardSeconds.toFixed(1)} s`
  const line = stale
    ? `${counted}, above the ${(threshold * 100).toFixed(0)}% threshold; recompute the table with ${RECOMPUTE_COMMAND}`
    : `${counted}, within the ${(threshold * 100).toFixed(0)}% threshold`
  return { drifted, driftedSeconds, longestShardSeconds, share, stale, line }
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
  return processGit.readOrNull(REPO_ROOT, args)?.trim()
}

function failWith(line: string): never {
  console.error(line)
  process.exit(1)
}

function mainRuns(): { databaseId: number, headSha: string }[] {
  const listed = CI.successfulRunsOnMain(RUNS_LISTED)
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
    const jobs = CI.jobsOfRun(run.databaseId)
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

export type Measurement
  = | { kind: 'measured', source: string, weights: TestWeights }
    | { kind: 'absent', line: string }

export function measurementAt(file: string, exists: (test: string) => boolean): Measurement {
  if (!existsSync(file))
    return { kind: 'absent', line: `no whole-file measurement ${FILE_WEIGHTS_NAME} at ${file}; the test span of ${path.basename(JSON_REPORT_PATH)} is never read, so the table is left as it is` }
  const weights = weightsFromFileWeights(JSON.parse(readFileSync(file, 'utf8')), exists)
  return Object.keys(weights).length === 0
    ? { kind: 'absent', line: `${file} measures no passed test file of this repository; the table is left as it is` }
    : { kind: 'measured', source: file, weights }
}

export function measurementFromRuns(runs: readonly number[], download: (run: number) => string | undefined, exists: (test: string) => boolean): Measurement {
  let predating = 0
  for (const run of runs) {
    const directory = download(run)
    if (directory === undefined)
      continue
    const measurement = measurementAt(path.join(directory, FILE_WEIGHTS_NAME), exists)
    if (measurement.kind === 'measured')
      return { ...measurement, source: `run ${run}` }
    predating += 1
  }
  return { kind: 'absent', line: `no successful push run on main carries ${FILE_WEIGHTS_NAME} in its ${CI_REPORT_ARTIFACT} artifact (${predating} carry only the JSON report, whose test span is not a file's weight); the table is left as it is until a main run carries the whole-file measurement` }
}

function downloadReport(run: number): string | undefined {
  const directory = mkdtempSync(path.join(tmpdir(), 'test-weights-'))
  return CI.downloadArtifact(run, { name: CI_REPORT_ARTIFACT, dir: directory }).done ? directory : undefined
}

function readWeights(): TestWeights {
  const file = path.join(REPO_ROOT, WEIGHTS_PATH)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as TestWeights : {}
}

const onDisk = (test: string): boolean => test !== '' && existsSync(path.join(REPO_ROOT, test))

const measurementOnMain = (): Measurement => measurementFromRuns(mainRuns().map(run => run.databaseId), downloadReport, onDisk)

function leftAsItIs(measurement: Measurement): measurement is Extract<Measurement, { kind: 'absent' }> {
  if (measurement.kind === 'absent')
    console.log(`test:weights: ${measurement.line}`)
  return measurement.kind === 'absent'
}

function checkAgainst(measurement: Measurement): void {
  if (leftAsItIs(measurement))
    return
  const verdict = weightsDrift(measurement.weights, readWeights())
  if (verdict.stale)
    failWith(`test:weights: ${verdict.line}`)
  console.log(`test:weights: ${verdict.line}`)
}

export function recomputedTable(previous: TestWeights, measured: TestWeights, exists: (test: string) => boolean): { weights: TestWeights, text: string } {
  const weights = updateWeights(previous, measured, exists)
  return { weights, text: `${JSON.stringify(weights, null, 2)}\n` }
}

function rewriteFrom(measurement: Measurement): void {
  if (leftAsItIs(measurement))
    return
  const previous = readWeights()
  const { weights, text } = recomputedTable(previous, measurement.weights, onDisk)
  writeFileSync(path.join(REPO_ROOT, WEIGHTS_PATH), text)
  const dropped = Object.keys(previous).filter(test => !(test in weights)).length
  console.log(`${WEIGHTS_PATH}: ${Object.keys(weights).length} files, ${Object.keys(measurement.weights).length} measured whole-file from ${measurement.source}, ${dropped} no longer on disk dropped`)
}

function main(argv: string[]): void {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name)
    return at === -1 ? undefined : argv[at + 1]
  }
  if (argv.includes('--spread'))
    return flag('--spread') === 'main' ? spreadOnMain(flag('--boundary')) : failWith(`usage: ${pnpmCommand('test:weights', '--spread', 'main', '[--boundary <sha>]')}`)
  if (argv.includes('--check'))
    return checkAgainst(measurementOnMain())
  if (argv.includes('--from'))
    return flag('--from') === 'main' ? rewriteFrom(measurementOnMain()) : failWith(`usage: ${RECOMPUTE_COMMAND}`)
  rewriteFrom(measurementAt(path.resolve(REPO_ROOT, argv[0] ?? FILE_WEIGHTS_PATH), onDisk))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2))

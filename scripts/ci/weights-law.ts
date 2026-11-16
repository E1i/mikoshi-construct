import type { TestWeights } from './shard.js'
import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FILE_WEIGHTS_NAME } from './file-weights-reporter.js'
import { balanceShards, MIN_WEIGHT, updateWeights, weightsFromFileWeights } from './shard.js'

export const CI_REPORT_ARTIFACT = 'vitest-report'
export const JSON_REPORT_PATH = '.construct/reports/vitest.json'
export const WEIGHTS_PATH = 'scripts/ci/test-weights.json'
export const CI_SHARDS = 8
export const MAX_DRIFTED_SHARE = 0.05
export const RECOMPUTE_DRIFTED_SHARE = 0.3
export const MAX_WEIGHT_RATIO = 2

const REPO = 'repos/{owner}/{repo}'
const OK = 200
const ABSENT = 404

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

export interface DriftFigures { drifted: string[], driftedSeconds: number, longestShardSeconds: number, share: number, stale: boolean }

function driftsFrom(measuredSeconds: number, weight: number | undefined): boolean {
  if (weight === undefined)
    return true
  const held = Math.max(MIN_WEIGHT, weight)
  const measured = Math.max(MIN_WEIGHT, measuredSeconds)
  return measured > held * MAX_WEIGHT_RATIO || held > measured * MAX_WEIGHT_RATIO
}

export function driftFigures(measured: TestWeights, weights: TestWeights, threshold: number): DriftFigures {
  const files = Object.keys(measured)
  const secondsOf = (list: readonly string[]): number => list.reduce((sum, file) => sum + measured[file]!, 0)
  const longestShardSeconds = Math.max(0, ...balanceShards(files, weights, CI_SHARDS).map(secondsOf))
  const drifted = files.filter(file => driftsFrom(measured[file]!, weights[file])).sort()
  const driftedSeconds = secondsOf(drifted)
  const share = longestShardSeconds === 0 ? 0 : driftedSeconds / longestShardSeconds
  return { drifted, driftedSeconds, longestShardSeconds, share, stale: share > threshold }
}

export function recomputedTable(previous: TestWeights, measured: TestWeights, exists: (test: string) => boolean): { weights: TestWeights, text: string } {
  const weights = updateWeights(previous, measured, exists)
  return { weights, text: `${JSON.stringify(weights, null, 2)}\n` }
}

export interface MainRunAt { databaseId: number, headSha: string }

export type ArtifactDownload = (runId: number, artifact: { name: string, dir: string }) => { done: true } | { done: false, reason: string }

export type ApiRead = (endpoint: string) => { status: number, body: unknown }

export type RunDrift
  = | { kind: 'unread', why: string }
    | { kind: 'fresh', share: number, line: number }
    | { kind: 'stale', share: number, driftedSeconds: number, longestShardSeconds: number, drifted: number, table: string }

function decodedContent(body: unknown): string | null {
  const content = (body as { content?: unknown } | null)?.content
  return typeof content === 'string' ? Buffer.from(content, 'base64').toString('utf8') : null
}

function tableAt(api: ApiRead, sha: string): TestWeights | string {
  const response = api(`${REPO}/contents/${WEIGHTS_PATH}?ref=${sha}`)
  if (response.status === ABSENT)
    return {}
  const text = response.status === OK ? decodedContent(response.body) : null
  return text === null ? `GitHub answered ${response.status} to the read of ${WEIGHTS_PATH} at ${sha}` : JSON.parse(text) as TestWeights
}

function treeAt(api: ApiRead, sha: string): Set<string> | string {
  const response = api(`${REPO}/git/trees/${sha}?recursive=1`)
  const body = response.body as { tree?: { path?: unknown }[], truncated?: unknown } | null
  if (response.status !== OK || !Array.isArray(body?.tree))
    return `GitHub answered ${response.status} to the read of the tree at ${sha}`
  if (body.truncated === true)
    return `GitHub truncated the tree at ${sha}, so which test files exist there is not known`
  return new Set(body.tree.flatMap(entry => typeof entry.path === 'string' ? [entry.path] : []))
}

function measuredIn(directory: string, download: ArtifactDownload, api: ApiRead, run: MainRunAt, line: number): RunDrift {
  const downloaded = download(run.databaseId, { name: CI_REPORT_ARTIFACT, dir: directory })
  if (!downloaded.done)
    return { kind: 'unread', why: `the ${CI_REPORT_ARTIFACT} artifact of run ${run.databaseId} was not downloaded: ${downloaded.reason}` }
  const tree = treeAt(api, run.headSha)
  if (typeof tree === 'string')
    return { kind: 'unread', why: tree }
  const measurement = measurementAt(path.join(directory, FILE_WEIGHTS_NAME), test => tree.has(test))
  if (measurement.kind === 'absent')
    return { kind: 'unread', why: `run ${run.databaseId}: ${measurement.line}` }
  const table = tableAt(api, run.headSha)
  if (typeof table === 'string')
    return { kind: 'unread', why: table }
  const drift = driftFigures(measurement.weights, table, line)
  if (!drift.stale)
    return { kind: 'fresh', share: drift.share, line }
  const { text } = recomputedTable(table, measurement.weights, test => tree.has(test))
  return { kind: 'stale', share: drift.share, driftedSeconds: drift.driftedSeconds, longestShardSeconds: drift.longestShardSeconds, drifted: drift.drifted.length, table: text }
}

export function driftOfRun(download: ArtifactDownload, api: ApiRead, run: MainRunAt, line = RECOMPUTE_DRIFTED_SHARE): RunDrift {
  const directory = mkdtempSync(path.join(tmpdir(), 'weights-drift-'))
  try {
    return measuredIn(directory, download, api, run, line)
  }
  catch (error) {
    return { kind: 'unread', why: `the drift of run ${run.databaseId} was not measured: ${error instanceof Error ? error.message : String(error)}` }
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

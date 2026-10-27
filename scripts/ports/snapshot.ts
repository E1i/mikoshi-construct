import type { Meter } from './meter.js'
import path from 'node:path'
import { readAttachRecord } from '../../src/commands/attach/record.js'
import { FACTORY_FORMER_FOLDERS, inScopes } from '../core/factory-paths.js'
import { cardIdOfDescription, isFullSha, prBodySha } from '../core/identifiers.js'
import { REQUIRED_CHECK, SECRET_SCAN_CHECK } from './gh.js'
import { REVIEW_STATUS_CONTEXT } from './github-status.js'

export const MAIN_BRANCH = 'main'
export const OPEN_PULLS_PAGE = 100
export const MECHANICS_PATHS = FACTORY_FORMER_FOLDERS.shift

export type Mergeable = 'clean' | 'behind' | 'dirty' | 'blocked'
export type CiReading = 'pending' | 'green' | 'red'
export type VerdictOnHead = 'pass' | 'changes'

export interface OpenPr {
  pr: number
  cardId: number | null
  base: string
  head: string
  mergeable: Mergeable
  ci: CiReading
  failedChecks: string[]
  verdictOnHead: VerdictOnHead | null
  autoMerge: boolean
  draft: boolean
  bodySha: string
}

export interface ClosedPr {
  pr: number
  cardId: number | null
  merged: boolean
  commit: string | null
  mergedBy: string | null
  mergedAt: string | null
}

export interface MainHead {
  sha: string
  touchesMechanics: boolean
}

export interface Snapshot {
  open: OpenPr[]
  closed: ClosedPr[]
  unsettled: number[]
  main: MainHead | null
}

export const MERGEABLE_OF_STATE: Record<string, Mergeable> = {
  clean: 'clean',
  unstable: 'clean',
  has_hooks: 'clean',
  behind: 'behind',
  dirty: 'dirty',
  blocked: 'blocked',
  draft: 'blocked',
}

const VERDICT_OF_STATE: Record<string, VerdictOnHead> = { success: 'pass', failure: 'changes' }

interface Pull {
  number: number
  state: string
  draft?: boolean
  body?: string | null
  merged?: boolean
  merge_commit_sha?: string | null
  merged_by?: { login?: string } | null
  merged_at?: string | null
  mergeable_state?: string
  auto_merge?: unknown
  base: { ref: string }
  head: { sha: string }
}

interface CheckRun {
  name?: string
  status?: string
  conclusion?: string | null
}

interface CommitStatus {
  context?: string
  state?: string
}

const REPO = 'repos/{owner}/{repo}'

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'])

function checkRunsOf(meter: Meter, sha: string): CheckRun[] {
  return (meter.get(`${REPO}/commits/${sha}/check-runs?per_page=100`) as { check_runs?: CheckRun[] }).check_runs ?? []
}

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

export function requiredCheckOf(root: string = REPO_ROOT): string {
  const harness = readAttachRecord(root)?.harness
  return typeof harness === 'object' && harness.job != null ? harness.job : REQUIRED_CHECK
}

function ciOfRuns(runs: CheckRun[], requiredCheck: string): CiReading {
  const required = runs.find(run => run.name === requiredCheck)
  if (required === undefined || required.status !== 'completed')
    return 'pending'
  if (required.conclusion !== 'success')
    return 'red'
  const secretScan = runs.find(run => run.name === SECRET_SCAN_CHECK)
  if (secretScan === undefined)
    return 'green'
  if (secretScan.status !== 'completed')
    return 'pending'
  return FAILED_CONCLUSIONS.has(secretScan.conclusion ?? '') ? 'red' : 'green'
}

function failedChecksOf(runs: CheckRun[], requiredCheck: string): string[] {
  return runs.flatMap(run => run.name !== undefined && run.name !== requiredCheck && run.status === 'completed' && FAILED_CONCLUSIONS.has(run.conclusion ?? '') ? [run.name] : [])
}

export function ciOf(meter: Meter, sha: string, requiredCheck = REQUIRED_CHECK): CiReading {
  return ciOfRuns(checkRunsOf(meter, sha), requiredCheck)
}

export function verdictOf(meter: Meter, sha: string): VerdictOnHead | null {
  const statuses = (meter.get(`${REPO}/commits/${sha}/status`) as { statuses?: CommitStatus[] }).statuses ?? []
  const review = statuses.find(status => status.context === REVIEW_STATUS_CONTEXT)
  return review?.state === undefined ? null : VERDICT_OF_STATE[review.state] ?? null
}

function openPrOf(meter: Meter, pull: Pull, requiredCheck: string): OpenPr | null {
  const mergeable = MERGEABLE_OF_STATE[pull.mergeable_state ?? '']
  if (mergeable === undefined)
    return null
  const runs = checkRunsOf(meter, pull.head.sha)
  const ci = ciOfRuns(runs, requiredCheck)
  return {
    pr: pull.number,
    cardId: cardIdOfDescription(pull.body),
    base: pull.base.ref,
    head: pull.head.sha,
    mergeable,
    ci,
    failedChecks: ci === 'red' ? failedChecksOf(runs, requiredCheck) : [],
    verdictOnHead: verdictOf(meter, pull.head.sha),
    autoMerge: pull.auto_merge !== null && pull.auto_merge !== undefined,
    draft: pull.draft === true,
    bodySha: prBodySha(pull.body),
  }
}

function closedPrOf(pull: Pull): ClosedPr {
  const merged = pull.merged === true
  return {
    pr: pull.number,
    cardId: cardIdOfDescription(pull.body),
    merged,
    commit: merged && isFullSha(pull.merge_commit_sha) ? pull.merge_commit_sha : null,
    mergedBy: merged ? pull.merged_by?.login ?? null : null,
    mergedAt: merged ? pull.merged_at ?? null : null,
  }
}

export function touchesMechanics(files: string[]): boolean {
  return files.some(file => inScopes(file, MECHANICS_PATHS))
}

function filenames(body: unknown): string[] {
  return ((body as { files?: { filename?: string }[] }).files ?? []).flatMap(file => file.filename === undefined ? [] : [file.filename])
}

function mainOf(meter: Meter, lastMain: string | null): MainHead | null {
  const commit = meter.get(`${REPO}/commits/${MAIN_BRANCH}`)
  const sha = (commit as { sha?: unknown }).sha
  if (!isFullSha(sha) || sha === lastMain)
    return null
  const files = lastMain === null ? filenames(commit) : filenames(meter.get(`${REPO}/compare/${lastMain}...${sha}`))
  return { sha, touchesMechanics: touchesMechanics(files) }
}

export function takeSnapshot(meter: Meter, known: number[], lastMain: string | null, requiredCheck = REQUIRED_CHECK): Snapshot {
  const listed = meter.get(`${REPO}/pulls?state=open&per_page=${OPEN_PULLS_PAGE}`) as Pull[]
  const snapshot: Snapshot = { open: [], closed: [], unsettled: [], main: null }
  const pulls = [...listed]
  const listedNumbers = new Set(listed.map(pull => pull.number))
  for (const pr of known.filter(number => !listedNumbers.has(number)))
    pulls.push(meter.get(`${REPO}/pulls/${pr}`) as Pull)
  for (const pull of pulls) {
    if (pull.state !== 'open') {
      snapshot.closed.push(closedPrOf(pull))
      continue
    }
    const open = openPrOf(meter, listedNumbers.has(pull.number) ? meter.get(`${REPO}/pulls/${pull.number}`) as Pull : pull, requiredCheck)
    if (open === null)
      snapshot.unsettled.push(pull.number)
    else
      snapshot.open.push(open)
  }
  snapshot.main = mainOf(meter, lastMain)
  return snapshot
}

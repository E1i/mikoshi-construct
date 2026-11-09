import type { CiObservation } from './ci-reading.js'
import type { Meter } from './meter.js'
import process from 'node:process'
import { readAttachRecord } from '../../src/commands/attach/record.js'
import { commitCi } from '../../src/commands/ci/state.js'
import { repositoryRoot } from '../core/bus-path.js'
import { FACTORY_FORMER_FOLDERS, inScopes } from '../core/factory-paths.js'
import { cardIdOfDescription, isFullSha, prBodySha } from '../core/identifiers.js'
import { ciFieldsOfObservation } from './ci-reading.js'
import { REQUIRED_CHECK } from './gh.js'
import { REVIEW_STATUS_CONTEXT } from './github-status.js'

export { ciOf } from './ci-reading.js'

export const MAIN_BRANCH = 'main'
export const OPEN_PULLS_PAGE = 100
export const MECHANICS_PATHS = FACTORY_FORMER_FOLDERS.shift

export const CANCELLED = 'cancelled'

export type Mergeable = 'clean' | 'behind' | 'dirty' | 'blocked'
export type VerdictOnHead = 'pass' | 'changes'

export interface OpenPr {
  pr: number
  cardId: number | null
  base: string
  head: string
  branch: string | null
  mergeable: Mergeable
  ciFields: CiObservation
  cancelledChecks?: string[]
  verdictOnHead: VerdictOnHead | null
  autoMerge: boolean
  draft: boolean
  bodySha: string
}

export interface ClosedPr {
  pr: number
  cardId: number | null
  branch?: string | null
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
  head: { sha: string, ref?: string }
}

interface ConcludedCheck {
  name?: string
  conclusion?: string | null
}

interface CiOnHead {
  ciFields: CiObservation
  cancelledChecks: string[]
}

interface CommitStatus {
  context?: string
  state?: string
}

const REPO = 'repos/{owner}/{repo}'

export function watchedRoot(): string {
  return repositoryRoot(process.cwd()) ?? process.cwd()
}

export function requiredCheckOf(root: string = watchedRoot()): string {
  const harness = readAttachRecord(root)?.harness
  return typeof harness === 'object' && harness.job != null ? harness.job : REQUIRED_CHECK
}

export function verdictOf(meter: Meter, sha: string): VerdictOnHead | null {
  const statuses = (meter.get(`${REPO}/commits/${sha}/status`) as { statuses?: CommitStatus[] }).statuses ?? []
  const review = statuses.find(status => status.context === REVIEW_STATUS_CONTEXT)
  return review?.state === undefined ? null : VERDICT_OF_STATE[review.state] ?? null
}

function cancelledAmong(bodies: readonly unknown[], failedChecks: readonly string[]): string[] {
  const cancelled = new Set(bodies.flatMap(body => ((body as { check_runs?: ConcludedCheck[] } | null)?.check_runs ?? []).flatMap(check => check.conclusion === CANCELLED && check.name !== undefined ? [check.name] : [])))
  return failedChecks.filter(name => cancelled.has(name))
}

function ciOnHead(meter: Meter, sha: string, requiredCheck: string): CiOnHead {
  const bodies: unknown[] = []
  const commit = commitCi({ get: (endpoint) => {
    const body = meter.get(endpoint)
    bodies.push(body)
    return body
  } }, sha, requiredCheck)
  return { ciFields: ciFieldsOfObservation(commit), cancelledChecks: cancelledAmong(bodies, commit.failedChecks) }
}

function openPrOf(meter: Meter, pull: Pull, requiredCheck: string): OpenPr | null {
  const mergeable = MERGEABLE_OF_STATE[pull.mergeable_state ?? '']
  if (mergeable === undefined)
    return null
  const ci = ciOnHead(meter, pull.head.sha, requiredCheck)
  return {
    pr: pull.number,
    cardId: cardIdOfDescription(pull.body),
    base: pull.base.ref,
    head: pull.head.sha,
    branch: pull.head.ref ?? null,
    mergeable,
    ciFields: ci.ciFields,
    cancelledChecks: ci.cancelledChecks,
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
    branch: pull.head.ref ?? null,
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

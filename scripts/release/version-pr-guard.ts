import type { GhPort } from '../ports/gh.js'
import type { ReleaseSource } from '../release-notes/release-body.js'
import { readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { PROCESS_GH_PORT } from '../ports/gh.js'
import { readReleaseSource, releaseBodyFault, renderReleaseBody } from '../release-notes/release-body.js'
import { CHANGESET_DIR, readReleaseRoute } from './changesets.js'

export const VERSION_PR_BRANCH_PREFIX = 'changeset-release/'

export const SMOKE_STATUS_CONTEXT = 'construct/consumer-smoke'

export interface VersionPrVerdict {
  passed: boolean
  lines: string[]
}

export const POSTED_STATES = ['success', 'failure', 'error', 'pending'] as const

type PostedState = typeof POSTED_STATES[number]

export type SmokeState = PostedState | 'missing' | 'unread'

export interface SmokeReading {
  state: SmokeState
  note: string
}

export const SMOKE_NOT_READ: SmokeReading = { state: 'unread', note: 'the consumer smoke status was not read' }

const STATUSES_PAGE = 100

export function isVersionPr(headRef: string | undefined): boolean {
  return headRef?.startsWith(VERSION_PR_BRANCH_PREFIX) ?? false
}

function pendingChangesetLines(headRef: string, dir: string): string[] {
  const { pending } = readReleaseRoute(dir)
  if (pending.length === 0)
    return []
  return [
    `${headRef} has not consumed ${pending.length === 1 ? 'a changeset' : `${pending.length} changesets`} that main carries:`,
    ...pending.map(file => `  ${dir}/${file}`),
    'Merging it now versions again instead of publishing, and no release reaches npm.',
    'Do not merge: wait for the release bot to update the version pull request, then let CI run on its new head.',
  ]
}

function releaseBodyLines(headRef: string, release: () => ReleaseSource): string[] {
  const fault = releaseBodyFault(renderReleaseBody(release()))
  return fault === null ? [] : [fault, `Do not merge ${headRef}: the publish would reach npm and then fail to create the GitHub release.`]
}

function smokeLines(headRef: string, smoke: SmokeReading): string[] {
  if (smoke.state === 'success')
    return []
  return [
    `${headRef} has no green consumer smoke on its head: ${SMOKE_STATUS_CONTEXT} is ${smoke.state} (${smoke.note}).`,
    'A capability with no green smoke run is not shipped as working.',
    `Do not merge: run scripts/release/consumer-smoke.ts on the factory against this head until it posts ${SMOKE_STATUS_CONTEXT} success, then re-run this check.`,
  ]
}

export function guardVersionPr(headRef: string | undefined, dir = CHANGESET_DIR, release: () => ReleaseSource = readReleaseSource, smoke: SmokeReading = SMOKE_NOT_READ): VersionPrVerdict {
  if (headRef === undefined || !isVersionPr(headRef))
    return { passed: true, lines: [`${headRef || 'this run'} is not a version pull request; nothing to guard.`] }

  const faults = [...pendingChangesetLines(headRef, dir), ...releaseBodyLines(headRef, release), ...smokeLines(headRef, smoke)]
  if (faults.length === 0)
    return { passed: true, lines: [`${headRef} has consumed every changeset on main, its GitHub release body is within the budget and its head carries a green consumer smoke; merging it publishes.`] }
  return { passed: false, lines: faults }
}

export type SmokeEnv = Partial<Record<'GITHUB_REPOSITORY' | 'GITHUB_EVENT_PATH', string>>

function headShaOf(eventPath: string | undefined): string | null {
  if (eventPath === undefined)
    return null
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as { pull_request?: { head?: { sha?: unknown } } }
    const sha = event.pull_request?.head?.sha
    return typeof sha === 'string' ? sha : null
  }
  catch {
    return null
  }
}

function isPostedState(value: unknown): value is PostedState {
  return POSTED_STATES.includes(value as PostedState)
}

function smokeOf(statuses: unknown): SmokeReading {
  const entries = Array.isArray(statuses) ? statuses as { context?: unknown, state?: unknown, description?: unknown }[] : []
  const latest = entries.find(entry => entry.context === SMOKE_STATUS_CONTEXT)
  if (latest === undefined)
    return { state: 'missing', note: 'the factory has posted no consumer smoke for this head' }
  const note = typeof latest.description === 'string' && latest.description.length > 0 ? latest.description : 'no description'
  if (!isPostedState(latest.state))
    return { state: 'error', note: `unrecognised state ${JSON.stringify(latest.state)}: ${note}` }
  return { state: latest.state, note }
}

function parsedStatuses(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown
  }
  catch {
    return null
  }
}

export function readSmokeStatus(env: SmokeEnv, port: GhPort = PROCESS_GH_PORT): SmokeReading {
  const repository = env.GITHUB_REPOSITORY
  const head = headShaOf(env.GITHUB_EVENT_PATH)
  if (repository === undefined || head === null)
    return { state: 'unread', note: 'this run names no repository or pull request head' }
  const read = port.call(['api', `repos/${repository}/commits/${head}/statuses?per_page=${STATUSES_PAGE}`])
  if (read.kind === 'failed')
    return { state: 'unread', note: `the statuses of ${head} could not be read: ${read.reason}` }
  return smokeOf(parsedStatuses(read.stdout))
}

function main(): void {
  const headRef = process.env.GITHUB_HEAD_REF
  const smoke = isVersionPr(headRef) ? readSmokeStatus(process.env) : SMOKE_NOT_READ
  const verdict = guardVersionPr(headRef, CHANGESET_DIR, readReleaseSource, smoke)
  const write = verdict.passed ? console.log : console.error
  write(verdict.lines.join('\n'))
  process.exitCode = verdict.passed ? 0 : 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()

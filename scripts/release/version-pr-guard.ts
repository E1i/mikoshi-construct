import { existsSync, readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../core/db.js'
import { PLAN_OPENED } from '../core/events.js'
import { openDatabase } from '../core/sqlite.js'
import { CHANGESET_DIR, readReleaseRoute } from './changesets.js'

export const VERSION_PR_BRANCH_PREFIX = 'changeset-release/'

export interface VersionPrVerdict {
  passed: boolean
  lines: string[]
}

export interface PlanVersion {
  plan: string
  version: string
}

export interface ReleaseVersions {
  plan: PlanVersion | null
  release: string
}

const LATEST_PLAN_VERSION = `
  SELECT json_extract(payload, '$.id') AS plan, json_extract(payload, '$.version') AS version FROM events
  WHERE type = '${PLAN_OPENED}' AND legacy = 0 AND actor = 'owner' AND json_extract(payload, '$.version') IS NOT NULL
  ORDER BY id DESC LIMIT 1
`

export function planVersionOnBus(busPath: string): PlanVersion | null {
  if (!existsSync(busPath))
    return null
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const row = db.prepare(LATEST_PLAN_VERSION).get() as { plan: unknown, version: unknown } | undefined
    return row === undefined ? null : { plan: String(row.plan), version: String(row.version) }
  }
  finally {
    db.close()
  }
}

export function releaseVersionOfPlan(planVersion: string): string {
  const bare = planVersion.replace(/^v/, '')
  return /^\d+\.\d+$/.test(bare) ? `${bare}.0` : bare
}

export function isVersionPr(headRef: string | undefined): headRef is string {
  return headRef?.startsWith(VERSION_PR_BRANCH_PREFIX) ?? false
}

export function guardVersionPr(headRef: string | undefined, versions: ReleaseVersions, dir = CHANGESET_DIR): VersionPrVerdict {
  if (!isVersionPr(headRef))
    return { passed: true, lines: [`${headRef || 'this run'} is not a version pull request; nothing to guard.`] }

  const { pending } = readReleaseRoute(dir)
  if (pending.length === 0)
    return versionAgainstPlan(headRef, versions)

  return {
    passed: false,
    lines: [
      `${headRef} has not consumed ${pending.length === 1 ? 'a changeset' : `${pending.length} changesets`} that main carries:`,
      ...pending.map(file => `  ${dir}/${file}`),
      'Merging it now versions again instead of publishing, and no release reaches npm.',
      'Do not merge: wait for the release bot to update the version pull request, then let CI run on its new head.',
    ],
  }
}

function versionAgainstPlan(headRef: string, { plan, release }: ReleaseVersions): VersionPrVerdict {
  const consumed = `${headRef} has consumed every changeset on main`
  if (plan === null)
    return { passed: true, lines: [`${consumed}; merging it publishes ${release}. No plan.opened on this bus carries a version, so ${release} is not checked against a plan.`] }
  const expected = releaseVersionOfPlan(plan.version)
  if (expected === release)
    return { passed: true, lines: [`${consumed} and versions ${release}, the version plan ${plan.plan} sets; merging it publishes.`] }
  return {
    passed: false,
    lines: [
      `${headRef} versions ${release}, but plan ${plan.plan} sets ${expected} (version: ${plan.version} in its plan.md).`,
      'Merging it publishes a release under a version the plan did not set.',
      `Do not merge: make the release changeset bump to ${expected} and let the release bot update the version pull request.`,
    ],
  }
}

function packageVersion(): string {
  return String((JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown }).version)
}

function main(): void {
  const verdict = guardVersionPr(process.env.GITHUB_HEAD_REF, { plan: planVersionOnBus(defaultBusPath()), release: packageVersion() })
  const write = verdict.passed ? console.log : console.error
  write(verdict.lines.join('\n'))
  process.exitCode = verdict.passed ? 0 : 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()

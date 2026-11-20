import type { ReleaseSource } from '../release-notes/release-body.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readReleaseSource, releaseBodyFault, renderReleaseBody } from '../release-notes/release-body.js'
import { CHANGESET_DIR, readReleaseRoute } from './changesets.js'

export const VERSION_PR_BRANCH_PREFIX = 'changeset-release/'

export interface VersionPrVerdict {
  passed: boolean
  lines: string[]
}

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

export function guardVersionPr(headRef: string | undefined, dir = CHANGESET_DIR, release: () => ReleaseSource = readReleaseSource): VersionPrVerdict {
  if (headRef === undefined || !isVersionPr(headRef))
    return { passed: true, lines: [`${headRef || 'this run'} is not a version pull request; nothing to guard.`] }

  const faults = [...pendingChangesetLines(headRef, dir), ...releaseBodyLines(headRef, release)]
  if (faults.length === 0)
    return { passed: true, lines: [`${headRef} has consumed every changeset on main and its GitHub release body is within the budget; merging it publishes.`] }
  return { passed: false, lines: faults }
}

function main(): void {
  const verdict = guardVersionPr(process.env.GITHUB_HEAD_REF)
  const write = verdict.passed ? console.log : console.error
  write(verdict.lines.join('\n'))
  process.exitCode = verdict.passed ? 0 : 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()

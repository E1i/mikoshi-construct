import { existsSync, readdirSync } from 'node:fs'
import process from 'node:process'
import { processGit } from '../ports/git.js'

export const CHANGESET_DIR = '.changeset'

export type ReleaseRoute = 'versioning' | 'publishing' | 'unknown'

export interface ReleaseRouteReading {
  dir: string
  route: ReleaseRoute
  pending: string[]
}

export function pendingChangesets(entries: string[]): string[] {
  return entries.filter(entry => entry.endsWith('.md') && entry.toLowerCase() !== 'readme.md')
}

export function routeFrom(entries: string[]): ReleaseRoute {
  return pendingChangesets(entries).length > 0 ? 'versioning' : 'publishing'
}

export function readReleaseRoute(dir = CHANGESET_DIR): ReleaseRouteReading {
  if (!existsSync(dir))
    return { dir, route: 'unknown', pending: [] }

  let entries: string[]
  try {
    entries = readdirSync(dir)
  }
  catch {
    return { dir, route: 'unknown', pending: [] }
  }

  return { dir, route: routeFrom(entries), pending: pendingChangesets(entries) }
}

export const RELEASE_PACKAGE = 'mikoshi-construct'
export const VERSION_PR_REF = 'origin/changeset-release/main'
export const MAIN_REF = 'origin/main'

const BUMPS = ['patch', 'minor', 'major'] as const

export type Bump = typeof BUMPS[number]

export interface ReleaseSources {
  versionPr: string | null
  main: string
  pending: string[]
}

export type GitRead = (args: string[]) => string | null

function unquoted(name: string): string {
  const trimmed = name.trim()
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
}

export function bumpOf(changeset: string, pkg = RELEASE_PACKAGE): Bump | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(changeset)?.[1] ?? ''
  const bump = front.split(/\r?\n/).map(entry => entry.split(':')).find(([name, , extra]) => extra === undefined && unquoted(name ?? '') === pkg)?.[1]?.trim() ?? ''
  return (BUMPS as readonly string[]).includes(bump) ? bump as Bump : null
}

export function raisedVersion(version: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] = versionParts(version)
  if (bump === 'major')
    return `${major + 1}.0.0`
  if (bump === 'minor')
    return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function versionParts(version: string): number[] {
  const [major = 0, minor = 0, patch = 0] = version.split('-')[0]!.split('.').map(Number)
  return [major, minor, patch]
}

export function isHigherVersion(version: string, than: string): boolean {
  const left = versionParts(version)
  const right = versionParts(than)
  const differing = left.findIndex((part, index) => part !== right[index])
  return differing !== -1 && left[differing]! > right[differing]!
}

export function releaseVersionFrom(sources: ReleaseSources, pkg = RELEASE_PACKAGE): string {
  if (sources.versionPr !== null && isHigherVersion(sources.versionPr, sources.main))
    return sources.versionPr
  const highest = sources.pending.map(text => bumpOf(text, pkg)).reduce<number>((top, bump) => Math.max(top, bump === null ? -1 : BUMPS.indexOf(bump)), -1)
  return highest === -1 ? sources.main : raisedVersion(sources.main, BUMPS[highest]!)
}

function versionAt(git: GitRead, ref: string): string | null {
  const text = git(['show', `${ref}:package.json`])
  if (text === null)
    return null
  const version = (JSON.parse(text) as { version?: unknown }).version
  return typeof version === 'string' ? version : null
}

export const RELEASE_FETCH = ['fetch', '--quiet', '--prune', 'origin', `+refs/heads/main:refs/remotes/${MAIN_REF}`, '+refs/heads/changeset-release/*:refs/remotes/origin/changeset-release/*']

function versionPrBuiltOnMain(git: GitRead): string | null {
  return git(['merge-base', '--is-ancestor', MAIN_REF, VERSION_PR_REF]) === null ? null : versionAt(git, VERSION_PR_REF)
}

export function readReleaseSources(git: GitRead): ReleaseSources | null {
  const main = versionAt(git, MAIN_REF)
  if (main === null)
    return null
  const listing = git(['ls-tree', '--name-only', `${MAIN_REF}:${CHANGESET_DIR}`]) ?? ''
  const pending = pendingChangesets(listing.split('\n').filter(entry => entry !== '')).map(file => git(['show', `${MAIN_REF}:${CHANGESET_DIR}/${file}`]) ?? '')
  return { versionPr: versionPrBuiltOnMain(git), main, pending }
}

export function gitIn(repo: string): GitRead {
  return (args) => {
    try {
      return processGit.read(repo, args)
    }
    catch {
      return null
    }
  }
}

export function readReleaseVersion(git: GitRead = gitIn(process.cwd())): string | null {
  if (git(RELEASE_FETCH) === null)
    return null
  const sources = readReleaseSources(git)
  return sources === null ? null : releaseVersionFrom(sources)
}

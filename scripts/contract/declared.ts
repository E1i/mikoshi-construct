import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const BUMP_LEVELS = ['none', 'patch', 'minor', 'major'] as const

export type BumpLevel = typeof BUMP_LEVELS[number]

const PACKAGE = 'mikoshi-construct'
const CHANGESET_ENTRY = new RegExp(`^["']?${PACKAGE}["']?\\s*:\\s*(patch|minor|major)\\s*$`)

export function strongest(levels: BumpLevel[]): BumpLevel {
  return levels.reduce<BumpLevel>((top, level) => BUMP_LEVELS.indexOf(level) > BUMP_LEVELS.indexOf(top) ? level : top, 'none')
}

function versionParts(version: string): number[] {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (parts == null)
    throw new Error(`${version} is not a semver version`)
  return parts.slice(1, 4).map(Number)
}

export function semverLevel(from: string, to: string): BumpLevel {
  const [before, after] = [versionParts(from), versionParts(to)]
  if (before[0] !== after[0])
    return 'major'
  if (before[1] !== after[1])
    return 'minor'
  return before[2] !== after[2] ? 'patch' : 'none'
}

export function changesetLevel(text: string): BumpLevel {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  const entry = frontmatter.split('\n').map(line => CHANGESET_ENTRY.exec(line.trim())).find(match => match != null)
  return (entry?.[1] as BumpLevel | undefined) ?? 'none'
}

export function readChangesets(dir: string): string[] {
  return readdirSync(dir)
    .filter(file => file.endsWith('.md') && file !== 'README.md')
    .sort()
    .map(file => readFileSync(path.join(dir, file), 'utf8'))
}

export function declaredFrom(baseVersion: string, headVersion: string, changesets: string[]): BumpLevel {
  if (baseVersion !== headVersion)
    return semverLevel(baseVersion, headVersion)
  return strongest(changesets.map(changesetLevel))
}

function versionOf(manifest: string): string {
  const version = (JSON.parse(manifest) as { version?: unknown }).version
  if (typeof version !== 'string')
    throw new Error('package.json carries no version')
  return version
}

export function headVersion(root: string): string {
  return versionOf(readFileSync(path.join(root, 'package.json'), 'utf8'))
}

export function declaredLevel(root: string, baseRef: string): BumpLevel {
  const baseVersion = versionOf(execFileSync('git', ['show', `${baseRef}:package.json`], { cwd: root, encoding: 'utf8' }))
  return declaredFrom(baseVersion, headVersion(root), readChangesets(path.join(root, '.changeset')))
}

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md')
export const RELEASE_NOTES_DIR = path.join(REPO_ROOT, 'docs/release-notes')
export const INDEX_PATH = path.join(RELEASE_NOTES_DIR, 'index.md')

const VERSION_HEADING = /^## (\d+\.\d+\.\d+)\s*$/

export interface ReleaseEntry {
  version: string
  body: string
}

export function parseChangelog(source: string): ReleaseEntry[] {
  const entries: ReleaseEntry[] = []
  let current: ReleaseEntry | null = null
  for (const line of source.split('\n')) {
    const heading = VERSION_HEADING.exec(line)
    if (heading != null) {
      current = { version: heading[1], body: '' }
      entries.push(current)
      continue
    }
    if (current != null)
      current.body += `${line}\n`
  }
  return entries.map(entry => ({ ...entry, body: entry.body.trim() }))
}

export function changelogVersions(source = readFileSync(CHANGELOG_PATH, 'utf8')): string[] {
  return parseChangelog(source).map(entry => entry.version)
}

export function handWrittenNotes(dir = RELEASE_NOTES_DIR): Map<string, string> {
  if (!existsSync(dir))
    return new Map()
  const pages = readdirSync(dir)
    .filter(file => /^\d+\.\d+\.\d+\.md$/.test(file))
    .map((file) => {
      const version = file.replace(/\.md$/, '')
      const title = /^# (.+)$/m.exec(readFileSync(path.join(dir, file), 'utf8'))
      return [version, title == null ? version : title[1]] as const
    })
  return new Map(pages)
}

export const SIDEBAR_LATEST = 5

export function releaseAnchor(version: string): string {
  return `/release-notes/#_${version.replaceAll('.', '-')}`
}

export function releaseSidebarItems(
  versions = changelogVersions(),
  notes = handWrittenNotes(),
): { text: string, link: string }[] {
  const named = new Set([...versions.slice(0, SIDEBAR_LATEST), ...[...notes.keys()].filter(version => versions.includes(version))])
  return versions
    .filter(version => named.has(version))
    .map(version => ({
      text: notes.has(version) ? `${version} — notes` : version,
      link: notes.has(version) ? `/release-notes/${version}` : releaseAnchor(version),
    }))
}

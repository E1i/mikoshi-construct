import type { ReleaseEntry } from './changelog.js'
import { parse } from 'yaml'

const BUMPS = ['major', 'minor', 'patch'] as const
type Bump = typeof BUMPS[number]

const HEADINGS: Record<Bump, string> = {
  major: '### Major Changes',
  minor: '### Minor Changes',
  patch: '### Patch Changes',
}

export const PENDING_VERSION = 'Unreleased'

export interface PendingChangeset {
  bump: Bump
  summary: string
}

const FENCE = '---'

export function parseChangeset(source: string): PendingChangeset | null {
  const text = source.replaceAll('\r\n', '\n')
  const close = text.indexOf(`\n${FENCE}`, FENCE.length)
  if (!text.startsWith(`${FENCE}\n`) || close === -1)
    return null
  const releases = Object.values((parse(text.slice(FENCE.length + 1, close)) ?? {}) as Record<string, string>)
  const bump = BUMPS.find(candidate => releases.includes(candidate))
  return bump == null ? null : { bump, summary: text.slice(close + FENCE.length + 1).trim() }
}

export function releaseLine(summary: string): string {
  const [first, ...rest] = summary.split('\n')
  return [`- ${first}`, ...rest.map(line => `  ${line}`)].join('\n')
}

export function pendingEntry(changesets: PendingChangeset[]): ReleaseEntry | null {
  const sections = BUMPS
    .map(bump => changesets.filter(changeset => changeset.bump === bump))
    .map((group, index) => group.length === 0
      ? null
      : [HEADINGS[BUMPS[index]], ...group.map(changeset => releaseLine(changeset.summary))].join('\n\n'))
    .filter(section => section != null)
  return sections.length === 0 ? null : { version: PENDING_VERSION, body: sections.join('\n\n') }
}

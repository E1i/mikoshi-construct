import type { ReleaseEntry } from './changelog.js'

const NOTICE_OPENING = /^> \*\*Recorded (\d{4}-\d{2}-\d{2})\b/

export interface ReleaseNotice {
  version: string
  recorded: string
  body: string
  names: string[]
}

function namedIn(body: string, version: string): boolean {
  return new RegExp(`\\b${version.replaceAll('.', '\\.')}\\b`).test(body)
}

function noticeIn(entry: ReleaseEntry, versions: string[]): ReleaseNotice | null {
  const lines = entry.body.split('\n')
  const opening = lines.findIndex(line => NOTICE_OPENING.test(line))
  if (opening === -1)
    return null

  let end = opening
  while (end < lines.length && lines[end].startsWith('>'))
    end++

  const body = lines.slice(opening, end).join('\n')
  const recorded = NOTICE_OPENING.exec(lines[opening])?.[1] ?? ''
  return {
    version: entry.version,
    recorded,
    body,
    names: versions.filter(version => version !== entry.version && namedIn(body, version)),
  }
}

export function parseNotices(entries: ReleaseEntry[]): ReleaseNotice[] {
  const versions = entries.map(entry => entry.version)
  return entries.flatMap(entry => noticeIn(entry, versions) ?? [])
}

export function unansweredNotices(notices: ReleaseNotice[]): string[] {
  const byVersion = new Map(notices.map(notice => [notice.version, notice]))
  return notices.flatMap(notice => notice.names
    .filter(named => byVersion.get(named)?.names.includes(notice.version) !== true)
    .map(named => `${notice.version} → ${named}`))
}

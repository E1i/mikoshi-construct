import type { ReleaseEntry } from './changelog.js'

const LEAD = `# Releases

Every released version, generated from [CHANGELOG.md](https://github.com/E1i/mikoshi-construct/blob/main/CHANGELOG.md).
Edit the changesets, then run \`pnpm release-notes:render\`; the test suite fails when this page and the
changelog drift apart. A release with a hand-written note links to it rather than repeating it here.`

function entrySection(entry: ReleaseEntry, handWritten: Map<string, string>): string {
  const title = handWritten.get(entry.version)
  const body = title == null ? entry.body : `[${title}](/release-notes/${entry.version})`
  return `## ${entry.version}\n\n${body}`
}

export function renderIndex(entries: ReleaseEntry[], handWritten: Map<string, string>): string {
  return `${[LEAD, ...entries.map(entry => entrySection(entry, handWritten))].join('\n\n')}\n`
}

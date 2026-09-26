import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHANGELOG_PATH, parseChangelog } from '../scripts/release-notes/changelog.js'
import { parseChangeset, PENDING_VERSION, pendingEntry, releaseLine } from '../scripts/release-notes/pending.js'
import { renderIndex } from '../scripts/release-notes/render.js'
import { packageScripts, resolvedScript } from './package-scripts.js'

const SHIPPED = readFileSync(path.join(import.meta.dirname, 'fixtures/release-notes/ladder-witnesses-the-acceptance.md'), 'utf8')
const GITHUB_PREFIX = /^- \[#\d+\]\([^)]+\) \[`[0-9a-f]+`\]\([^)]+\) Thanks \[@[^\]]+\]\([^)]+\)! - /

function publishedLine(pr: number): string {
  const body = parseChangelog(readFileSync(CHANGELOG_PATH, 'utf8')).map(entry => entry.body).join('\n\n')
  const start = body.indexOf(`- [#${pr}](`)
  const end = body.indexOf('\n\n- ', start + 1)
  return body.slice(start, end === -1 ? undefined : end).replace(GITHUB_PREFIX, '- ')
}

describe('a pending changeset is rendered the way changesets will write it', () => {
  it('reads the bump and the summary out of a changeset', () => {
    const parsed = parseChangeset(SHIPPED)
    expect(parsed?.bump).toBe('patch')
    expect(parsed?.summary.startsWith('The implement ladder reports `done`')).toBe(true)
  })

  it('reproduces the line changesets published for #241, minus the GitHub links', () => {
    const published = publishedLine(241)
    expect(published.split('\n').length).toBeGreaterThan(3)
    expect(releaseLine(parseChangeset(SHIPPED)!.summary)).toBe(published)
  })

  it('indents every continuation line by two spaces, blank ones included', () => {
    expect(releaseLine('first\n\n- item')).toBe('- first\n  \n  - item')
  })

  it('skips a changeset that releases nothing', () => {
    expect(parseChangeset('---\n---\n\nnothing released')).toBeNull()
    expect(pendingEntry([])).toBeNull()
  })

  it('groups pending changesets under the headings changesets uses, major first', () => {
    const entry = pendingEntry([
      { bump: 'patch', summary: 'a fix' },
      { bump: 'minor', summary: 'a feature' },
    ])
    expect(entry?.version).toBe(PENDING_VERSION)
    expect(entry?.body).toBe('### Minor Changes\n\n- a feature\n\n### Patch Changes\n\n- a fix')
  })

  it('puts the pending entry on the release index above the released versions', () => {
    const rendered = renderIndex([pendingEntry([{ bump: 'patch', summary: 'a fix' }])!], new Map())
    expect(rendered).toContain(`## ${PENDING_VERSION}\n\n### Patch Changes\n\n- a fix`)
  })
})

describe('the harness builds the docs with the pending changesets in them', () => {
  it('reaches the pending build from quality, so a changeset that breaks the docs fails on its own pull request', () => {
    expect(resolvedScript('quality', packageScripts())).toContain('scripts/docs/build-pending.ts')
  })
})

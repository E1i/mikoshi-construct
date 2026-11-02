import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { guardVersionPr } from '../../release/version-pr-guard.js'

function changesetDir(files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-version-pr-'))
  for (const name of files)
    writeFileSync(path.join(dir, name), '')
  return dir
}

describe('a version pull request cannot merge over a changeset it has not consumed', () => {
  it('refuses changeset-release/main while the merged tree carries a pending changeset, naming it and what to do', () => {
    const dir = changesetDir(['README.md', 'config.json', 'olive-pugs-repeat.md'])

    const verdict = guardVersionPr('changeset-release/main', dir)

    expect(verdict.passed).toBe(false)
    const text = verdict.lines.join('\n')
    expect(text).toContain(`${dir}/olive-pugs-repeat.md`)
    expect(text).not.toContain('README.md')
    expect(text).toMatch(/wait for the release bot to update the version pull request/)
  })

  it('names every pending changeset, not only the first', () => {
    const dir = changesetDir(['config.json', 'olive-pugs-repeat.md', 'ninety-nine-moles-sit.md'])

    const text = guardVersionPr('changeset-release/main', dir).lines.join('\n')

    expect(text).toContain('olive-pugs-repeat.md')
    expect(text).toContain('ninety-nine-moles-sit.md')
  })

  it('passes changeset-release/main once every changeset is consumed', () => {
    expect(guardVersionPr('changeset-release/main', changesetDir(['README.md', 'config.json'])).passed).toBe(true)
  })

  it('passes any other branch carrying a pending changeset, which is the ordinary feature pull request', () => {
    expect(guardVersionPr('version-pr-guard', changesetDir(['config.json', 'olive-pugs-repeat.md'])).passed).toBe(true)
  })

  it('passes a run with no pull request head, as push and merge_group runs have', () => {
    expect(guardVersionPr(undefined, changesetDir(['olive-pugs-repeat.md'])).passed).toBe(true)
    expect(guardVersionPr('', changesetDir(['olive-pugs-repeat.md'])).passed).toBe(true)
  })
})

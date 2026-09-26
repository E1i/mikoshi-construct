import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const BROKEN = path.join(import.meta.dirname, 'fixtures/release-notes/pre-242-ladder-witnesses-the-acceptance.md')
const COPIED = ['package.json', 'CHANGELOG.md', 'docs', 'scripts/docs', 'scripts/release-notes']

function repositoryWithABrokenChangeset(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-docs-pending-'))
  for (const part of COPIED)
    cpSync(path.join(REPO_ROOT, part), path.join(root, part), { recursive: true })
  rmSync(path.join(root, 'docs/.vitepress/cache'), { recursive: true, force: true })
  rmSync(path.join(root, 'docs/.vitepress/dist'), { recursive: true, force: true })
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'))
  mkdirSync(path.join(root, '.changeset'))
  cpSync(BROKEN, path.join(root, '.changeset/broken.md'))
  return root
}

describe('the pending docs build leaves no copy behind when it fails', () => {
  const root = repositoryWithABrokenChangeset()
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('fails on the changeset text and removes .docs-pending', () => {
    const run = spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), ['scripts/docs/build-pending.ts'], { cwd: root, encoding: 'utf8' })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('Element is missing end tag')
    expect(run.stderr).toContain('.changeset/broken.md')
    expect(existsSync(path.join(root, '.docs-pending'))).toBe(false)
  }, 120_000)
})

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { VERSION_PACKAGES_EDITS } from './version-packages.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const VERSION_COMMIT_FILES = path.resolve(import.meta.dirname, '../fixtures/contract/version-packages-files.txt')

function versionCommitFiles(): string[] {
  return readFileSync(VERSION_COMMIT_FILES, 'utf8').split('\n').filter(line => line !== '')
}

function repositoryFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '')
}

function vanishedWhileCopying(error: unknown, source: string): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(source)
}

function copyIfPresent(source: string, target: string): void {
  try {
    copyFileSync(source, target)
  }
  catch (error) {
    if (!vanishedWhileCopying(error, source))
      throw error
  }
}

function repositoryCopy(): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'construct-surface-version-')), 'repo')
  for (const file of repositoryFiles()) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    copyIfPresent(path.join(REPO_ROOT, file), path.join(root, file))
  }
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'))
  return root
}

function generatedSurface(root: string): string {
  execFileSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'scripts/contract/update.ts')], { cwd: root, stdio: 'ignore' })
  return readFileSync(path.join(root, 'contract/surface.json'), 'utf8')
}

function contentOf(root: string, file: string): string | null {
  const target = path.join(root, file)
  return existsSync(target) ? readFileSync(target, 'utf8') : null
}

describe('the generator reads nothing `changeset version` writes', () => {
  it('every file the version commit wrote is emulated', () => {
    const emulated = new Set(VERSION_PACKAGES_EDITS.map(edit => edit.path))
    const files = versionCommitFiles()
    expect(files.length).toBeGreaterThan(0)
    expect(files.filter(file => !emulated.has(file))).toEqual([])
  })

  it('produces a byte-identical surface before and after the emulated version commit', () => {
    const root = repositoryCopy()
    for (const edit of VERSION_PACKAGES_EDITS)
      edit.before?.(root)
    const before = generatedSurface(root)
    const untouched = VERSION_PACKAGES_EDITS.map(edit => contentOf(root, edit.path))

    for (const edit of VERSION_PACKAGES_EDITS)
      edit.after(root)
    const changed = VERSION_PACKAGES_EDITS.filter((edit, index) => contentOf(root, edit.path) === untouched[index]).map(edit => edit.path)
    expect(changed, 'emulated edits that changed nothing').toEqual([])

    expect(generatedSurface(root)).toBe(before)
  }, 180_000)
})

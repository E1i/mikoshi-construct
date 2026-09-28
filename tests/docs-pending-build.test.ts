import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const BROKEN = path.join(import.meta.dirname, 'fixtures/release-notes/pre-242-ladder-witnesses-the-acceptance.md')
const COPIED = ['package.json', 'CHANGELOG.md', 'docs', 'scripts/docs', 'scripts/release-notes']

function repositoryWith(changeset: (target: string) => void): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-docs-pending-'))
  for (const part of COPIED)
    cpSync(path.join(REPO_ROOT, part), path.join(root, part), { recursive: true })
  rmSync(path.join(root, 'docs/.vitepress/cache'), { recursive: true, force: true })
  rmSync(path.join(root, 'docs/.vitepress/dist'), { recursive: true, force: true })
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'))
  mkdirSync(path.join(root, '.changeset'))
  changeset(path.join(root, '.changeset/pending.md'))
  return root
}

const repositoryWithABrokenChangeset = () => repositoryWith(target => cpSync(BROKEN, target))
const repositoryWithAValidChangeset = () => repositoryWith(target => writeFileSync(target, '---\n\'mikoshi-construct\': patch\n---\n\nA pending change.\n'))

describe('the pending docs build leaves no copy behind when it fails', () => {
  const root = repositoryWithABrokenChangeset()
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('fails on the changeset text and leaves the repository as it found it', () => {
    const before = readdirSync(root).sort()
    const run = spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), ['scripts/docs/build-pending.ts'], { cwd: root, encoding: 'utf8' })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('Element is missing end tag')
    expect(run.stderr).toContain('.changeset/pending.md')
    expect(readdirSync(root).sort()).toEqual(before)
  }, 120_000)
})

describe('the pending docs build leaves no copy in the repository when it is killed mid-build', () => {
  const root = repositoryWithAValidChangeset()
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('writes nothing under the root that a SIGKILL during the build could strand', async () => {
    const before = readdirSync(root).sort()
    const run = spawn(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), ['scripts/docs/build-pending.ts'], { cwd: root })
    await new Promise<void>((resolve, reject) => {
      for (const stream of [run.stdout, run.stderr]) {
        stream.on('data', (chunk: unknown) => {
          if (String(chunk).includes('building client'))
            resolve()
        })
      }
      run.on('exit', code => reject(new Error(`the build exited ${code} before it started building`)))
    })
    const exited = new Promise(resolve => run.on('exit', resolve))
    run.kill('SIGKILL')
    await exited

    expect(readdirSync(root).sort()).toEqual(before)
    expect(existsSync(path.join(root, '.docs-pending'))).toBe(false)
  }, 120_000)
})

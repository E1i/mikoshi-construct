import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'
import { InMemoryGit, processGit } from '../../ports/git.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const LADDER = 'scripts/ladder/'
const PLANTED_FILE = 'scripts/ladder/planted.ts'
const SCAN_TIMEOUT = 180_000
const GIT_CONCEPT = CONCEPTS.filter(concept => concept.id === 'git')

const PLANTED: readonly (readonly [string, string])[] = [
  ['an execFileSync of git', 'import { execFileSync } from \'node:child_process\'\nexport const head = execFileSync(\'git\', [\'rev-parse\', \'HEAD\'])'],
  ['a spawnSync of git', 'import { spawnSync } from \'node:child_process\'\nexport const status = spawnSync(\'git\', [\'status\'])'],
]

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'git-seal-ladder-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function ladderFilesCallingGit(root: string): string[] {
  const section = overlapsSection(findSites(root, GIT_CONCEPT), GIT_CONCEPT)
  return Object.keys(section.git ?? {}).filter(file => file.startsWith(LADDER)).sort()
}

describe('the seal of git in the ladder', () => {
  it('a git call planted in the ladder outside the port is red', () => {
    for (const [label, text] of PLANTED)
      expect(ladderFilesCallingGit(treeWith({ [PLANTED_FILE]: text })), label).toEqual([PLANTED_FILE])
  })

  it('no git call outside the port in the ladder area', { timeout: SCAN_TIMEOUT }, () => {
    expect(ladderFilesCallingGit(REPO_ROOT)).toEqual([])
  })

  it('the process adapter reads, reads bytes and answers yes or no from a real tree', () => {
    const head = processGit.read(REPO_ROOT, ['rev-parse', 'HEAD']).trim()

    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(processGit.succeeds(REPO_ROOT, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`])).toBe(true)
    expect(processGit.succeeds(REPO_ROOT, ['rev-parse', '--verify', '--quiet', 'refs/heads/no-such-branch-of-the-seal'])).toBe(false)
    expect(processGit.readBytes(REPO_ROOT, ['show', `${head}:package.json`], 64 * 1024 * 1024).toString('utf8')).toContain('"name"')
    expect(() => processGit.read(REPO_ROOT, ['show', `${head}:no-such-file-of-the-seal`])).toThrow(/no-such-file-of-the-seal/)
  })

  it('the in-memory adapter answers from its script and records each call', () => {
    const git = new InMemoryGit(({ args }) => args[0] === 'merge-base' ? new Error('not an ancestor') : 'abc\n')

    expect(git.read('/tree', ['rev-parse', 'HEAD'])).toBe('abc\n')
    expect(git.readBytes('/tree', ['show', 'HEAD:a'])).toEqual(Buffer.from('abc\n'))
    expect(git.succeeds('/tree', ['merge-base', '--is-ancestor', 'a', 'b'])).toBe(false)
    expect(() => git.read('/tree', ['merge-base'])).toThrow('not an ancestor')
    expect(git.calls.map(call => call.args[0])).toEqual(['rev-parse', 'show', 'merge-base', 'merge-base'])
  })
})

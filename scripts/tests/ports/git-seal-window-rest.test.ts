import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS, GIT_BEYOND_THE_PORT } from '../../contract/factory/concepts.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'
import { InMemoryGit } from '../../ports/git.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const SCAN_TIMEOUT = 180_000
const GIT_CONCEPT = CONCEPTS.filter(concept => concept.id === 'git')

const THROUGH_THE_PORT = [
  'scripts/atlas/build.ts',
  'scripts/attach/earlier-carriers.ts',
  'scripts/ci/prepush.ts',
  'scripts/ci/select.ts',
  'scripts/ci/test-weights.ts',
  'scripts/done/tree.ts',
  'scripts/policy/shard.ts',
  'scripts/ports/card-tree.ts',
  'scripts/ports/diff.ts',
  'scripts/ports/prepare-tree.ts',
  'scripts/ports/task-start.ts',
  'scripts/ports/tree-publish.ts',
  'scripts/ports/worktree.ts',
  'scripts/supervisor/supervisor.ts',
  'scripts/window/owner-command.ts',
  'scripts/window/pull.ts',
  'scripts/window/window-agents.ts',
  'scripts/window/window-request-tools.ts',
]

const PLANTED: readonly (readonly [string, string, string])[] = [
  ['an execFileSync of git in the window', 'scripts/window/planted.ts', 'import { execFileSync } from \'node:child_process\'\nexport const head = execFileSync(\'git\', [\'rev-parse\', \'HEAD\'])'],
  ['a spawnSync of git in ci', 'scripts/ci/planted.ts', 'import { spawnSync } from \'node:child_process\'\nexport const diff = spawnSync(\'git\', [\'diff\', \'--name-only\'])'],
  ['an execFile of git in a port', 'scripts/ports/planted.ts', 'import { execFile } from \'node:child_process\'\nexport const later = execFile(\'git\', [\'status\'])'],
  ['a spawnSync of git in src beside detect', 'src/detect/planted.ts', 'import { spawnSync } from \'node:child_process\'\nexport const files = spawnSync(\'git\', [\'ls-files\'])'],
  ['an execFileSync of git in core beside the named two', 'scripts/core/planted.ts', 'import { execFileSync } from \'node:child_process\'\nexport const sha = execFileSync(\'git\', [\'rev-parse\', \'HEAD\'])'],
]

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'git-seal-window-rest-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'), { recursive: true })
  mkdirSync(path.join(root, 'scripts'), { recursive: true })
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function filesCallingGit(root: string): string[] {
  const section = overlapsSection(findSites(root, GIT_CONCEPT), GIT_CONCEPT)
  return Object.keys(section.git ?? {}).sort()
}

describe('the seal of git in the window and the rest', () => {
  it('a git call planted outside the port is red, beside the files the port cannot reach too', () => {
    for (const [label, file, text] of PLANTED)
      expect(filesCallingGit(treeWith({ [file]: text })), label).toEqual([file])
  })

  it('the files the port cannot reach are named, and each still runs git itself', () => {
    expect([...GIT_BEYOND_THE_PORT].sort()).toEqual(['scripts/construct/check-acceptance.mjs', 'scripts/core/node.ts', 'scripts/core/push-policy.ts', 'src/detect/git.ts'])
    for (const file of GIT_BEYOND_THE_PORT)
      expect(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file).toMatch(/(?:spawnSync|execFileSync)\('git'/)
  })

  it('the in-memory port answers the asynchronous read the trees use', async () => {
    const git = new InMemoryGit(({ args }) => args[0] === 'worktree' ? 'listed\n' : new Error('unknown'))

    await expect(git.readLater('/repo', ['worktree', 'list'])).resolves.toBe('listed\n')
    await expect(git.readLater('/repo', ['fetch'])).rejects.toThrow('unknown')
    expect(git.calls).toEqual([{ tree: '/repo', args: ['worktree', 'list'] }, { tree: '/repo', args: ['fetch'] }])
  })

  it('a read that may fail answers null instead of throwing', () => {
    const git = new InMemoryGit(({ args }) => args.includes('refs/heads/main') ? 'abc\n' : new Error('no such ref'))

    expect(git.readOrNull('/repo', ['rev-parse', '--verify', 'refs/heads/main'])).toBe('abc\n')
    expect(git.readOrNull('/repo', ['rev-parse', '--verify', 'refs/heads/gone'])).toBeNull()
  })

  it('no git call outside the port in the window-rest area', { timeout: SCAN_TIMEOUT }, () => {
    const calling = filesCallingGit(REPO_ROOT)

    expect(calling.filter(file => THROUGH_THE_PORT.includes(file))).toEqual([])
    expect(calling).toEqual([])
  })
})

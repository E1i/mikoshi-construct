import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS, GIT_BEYOND_THE_PORT, GIT_BEYOND_THE_PORT_BY_REASON } from '../../contract/factory/concepts.js'
import { programCall } from '../../contract/factory/detectors.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'
import { InMemoryGit } from '../../ports/git.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const SCAN_TIMEOUT = 180_000
const GIT_CONCEPT = CONCEPTS.filter(concept => concept.id === 'git')

const CALLS_BEYOND_THE_PORT = {
  'scripts/construct/check-acceptance.mjs': 1,
  'scripts/core/node.ts': 1,
  'scripts/core/push-policy.ts': 1,
  'src/detect/git.ts': 1,
}

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

  it('the files the port cannot reach keep only the git call each has today, so a new one there is red', { timeout: SCAN_TIMEOUT }, () => {
    const unexempted = GIT_CONCEPT.map(concept => ({ ...concept, detectors: [programCall(['git'])] }))
    const section = overlapsSection(findSites(REPO_ROOT, unexempted), unexempted).git ?? {}
    const exempted = Object.fromEntries(Object.entries(section).filter(([file]) => GIT_BEYOND_THE_PORT.has(file)))

    expect(exempted).toEqual(CALLS_BEYOND_THE_PORT)
    expect(Object.keys(section).filter(file => !GIT_BEYOND_THE_PORT.has(file))).toEqual([])
  })

  it('each file the port cannot reach is named under the boundary that keeps the port out', () => {
    expect(GIT_BEYOND_THE_PORT_BY_REASON).toEqual({
      'src-imports-no-scripts': ['src/detect/git.ts'],
      'a-template-carrier-runs-without-the-factory': ['scripts/construct/check-acceptance.mjs'],
      'core-imports-nothing-to-its-right': ['scripts/core/node.ts', 'scripts/core/push-policy.ts'],
    })
  })

  it('a second git call planted in a file the port cannot reach is counted', () => {
    const unexempted = GIT_CONCEPT.map(concept => ({ ...concept, detectors: [programCall(['git'])] }))
    const twice = 'import { execFileSync } from \'node:child_process\'\nexport const a = execFileSync(\'git\', [\'status\'])\nexport const b = execFileSync(\'git\', [\'log\'])'
    const root = treeWith({ 'scripts/core/push-policy.ts': twice })

    expect(filesCallingGit(root)).toEqual([])
    expect(overlapsSection(findSites(root, unexempted), unexempted).git).toEqual({ 'scripts/core/push-policy.ts': 2 })
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

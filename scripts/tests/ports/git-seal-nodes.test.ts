import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const NODES = 'scripts/nodes/'
const PLANTED_FILE = 'scripts/nodes/review/planted.ts'
const SCAN_TIMEOUT = 180_000
const GIT_CONCEPT = CONCEPTS.filter(concept => concept.id === 'git')

const THROUGH_THE_PORT = [
  'scripts/nodes/answer/answerer.ts',
  'scripts/nodes/answer/duties/tree.ts',
  'scripts/nodes/close/close-executor.ts',
  'scripts/nodes/close/ended-card-trees.ts',
  'scripts/nodes/launch/lane-assign.ts',
  'scripts/nodes/launch/launch-root.ts',
  'scripts/nodes/launch/launch-starter.ts',
  'scripts/nodes/launch/tree-pr-cli.ts',
  'scripts/nodes/review/depth-sources.ts',
  'scripts/nodes/review/reviewer.ts',
]

const PLANTED: readonly (readonly [string, string])[] = [
  ['an execFileSync of git', 'import { execFileSync } from \'node:child_process\'\nexport const head = execFileSync(\'git\', [\'rev-parse\', \'HEAD\'])'],
  ['a spawnSync of git', 'import { spawnSync } from \'node:child_process\'\nexport const status = spawnSync(\'git\', [\'status\'])'],
]

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'git-seal-nodes-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function nodesFilesCallingGit(root: string): string[] {
  const section = overlapsSection(findSites(root, GIT_CONCEPT), GIT_CONCEPT)
  return Object.keys(section.git ?? {}).filter(file => file.startsWith(NODES)).sort()
}

describe('the seal of git in the nodes', () => {
  it('a git call planted in a node outside the port is red', () => {
    for (const [label, text] of PLANTED)
      expect(nodesFilesCallingGit(treeWith({ [PLANTED_FILE]: text })), label).toEqual([PLANTED_FILE])
  })

  it('no git call outside the port in the nodes area', { timeout: SCAN_TIMEOUT }, () => {
    const calling = nodesFilesCallingGit(REPO_ROOT)

    expect(calling.filter(file => THROUGH_THE_PORT.includes(file))).toEqual([])
    expect(calling).toEqual([])
  })
})

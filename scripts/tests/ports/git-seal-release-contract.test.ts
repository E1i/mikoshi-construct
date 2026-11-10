import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const AREA = ['scripts/contract/', 'scripts/release/']
const SCAN_TIMEOUT = 180_000
const GIT_CONCEPT = CONCEPTS.filter(concept => concept.id === 'git')

const THROUGH_THE_PORT = [
  'scripts/contract/bump.ts',
  'scripts/contract/declared.ts',
  'scripts/contract/json-samples.ts',
  'scripts/contract/surface.ts',
  'scripts/release/changesets.ts',
  'scripts/release/evidence.ts',
  'scripts/release/security-diff.ts',
]

const PLANTED: readonly (readonly [string, string, string])[] = [
  ['an execFileSync of git in the contract', 'scripts/contract/planted.ts', 'import { execFileSync } from \'node:child_process\'\nexport const tag = execFileSync(\'git\', [\'describe\', \'--tags\'])'],
  ['a spawnSync of git in the release', 'scripts/release/planted.ts', 'import { spawnSync } from \'node:child_process\'\nexport const list = spawnSync(\'git\', [\'rev-list\', \'HEAD\'])'],
]

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'git-seal-release-contract-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function areaFilesCallingGit(root: string): string[] {
  const section = overlapsSection(findSites(root, GIT_CONCEPT), GIT_CONCEPT)
  return Object.keys(section.git ?? {}).filter(file => AREA.some(area => file.startsWith(area))).sort()
}

describe('the seal of git in the release and the contract', () => {
  it('a git call planted in the release or the contract outside the port is red', () => {
    for (const [label, file, text] of PLANTED)
      expect(areaFilesCallingGit(treeWith({ [file]: text })), label).toEqual([file])
  })

  it('no git call outside the port in the release-contract area', { timeout: SCAN_TIMEOUT }, () => {
    const calling = areaFilesCallingGit(REPO_ROOT)

    expect(calling.filter(file => THROUGH_THE_PORT.includes(file))).toEqual([])
    expect(calling).toEqual([])
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS, GIT_BEYOND_THE_PORT } from '../../contract/factory/concepts.js'
import { programCall } from '../../contract/factory/detectors.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'
import { parsedFiles } from '../../contract/factory/walk.js'

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const CORE = 'scripts/core/'
const CHILD_PROCESS = /from\s+'node:child_process'|require\(\s*'node:child_process'\s*\)|import\(\s*'node:child_process'\s*\)/
const GIT_ANYWHERE = CONCEPTS.filter(concept => concept.id === 'git').map(concept => ({ ...concept, detectors: [programCall(['git'])] }))

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(planted: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'core-runs-no-git-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  mkdirSync(path.join(root, CORE), { recursive: true })
  for (const [file, text] of Object.entries(planted))
    writeFileSync(path.join(root, file), text)
  return root
}

function coreFilesRunningGit(root: string): string[] {
  return Object.keys(overlapsSection(findSites(root, GIT_ANYWHERE), GIT_ANYWHERE).git ?? {}).filter(file => file.startsWith(CORE)).sort()
}

describe('core runs no git', () => {
  it('no file under scripts/core runs git or imports child_process', () => {
    expect(parsedFiles(REPO, [CORE]).filter(({ source }) => CHILD_PROCESS.test(source.text)).map(({ file }) => file)).toEqual([])
    expect(coreFilesRunningGit(REPO)).toEqual([])
  })

  it('a git call planted in core is found, so the check above can fail', () => {
    const planted = 'import { execFileSync } from \'node:child_process\'\nexport const sha = execFileSync(\'git\', [\'rev-parse\', \'HEAD\'])'
    const root = treeWith({ 'scripts/core/planted.ts': planted })

    expect(coreFilesRunningGit(root)).toEqual(['scripts/core/planted.ts'])
    expect(parsedFiles(root, [CORE]).filter(({ source }) => CHILD_PROCESS.test(source.text)).map(({ file }) => file)).toEqual(['scripts/core/planted.ts'])
  })

  it('no file under scripts/core stands beyond the git port', () => {
    expect([...GIT_BEYOND_THE_PORT].filter(file => file.startsWith(CORE))).toEqual([])
  })
})

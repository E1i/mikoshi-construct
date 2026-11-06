import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS, isOwnedBy } from '../../contract/factory/concepts.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const OWNER = 'src/commands/ci/state.ts'
const PORT = 'scripts/ports/ci-reading.ts'
const BOARD = 'src/commands/board/prs.ts'
const SCAN_TIMEOUT = 180_000
const CI_READING = [CONCEPTS.find(concept => concept.id === 'ci-reading')!]
const IMPORT_SOURCE = /^(?:import\s+|(?:import|export)\b[^']*?\sfrom\s+)'([^']+)'/gm

type SitesPerFile = Record<string, number>

const PLANTED: readonly (readonly [string, string])[] = [
  ['a declared reader', 'export function ciOf() { return 1 }'],
  ['a declared log reader', 'export function failedJobLog() { return 1 }'],
  ['a rollup read', 'export const rollup = (view: any) => view.statusCheckRollup'],
  ['a request by its literal', 'export const url = \'repos/{owner}/{repo}/commits/abc/check-runs\''],
  ['a gh run command', 'export const args = [\'run\', \'view\', \'1\']'],
  ['a gh pr checks command', 'export const args = [\'pr\', \'checks\', \'1\']'],
  ['a copied state', 'export const copy = (open: any) => ({ ci: open.ci })'],
]

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-seal-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  mkdirSync(path.join(root, 'scripts'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function sitesPerFile(root: string): SitesPerFile {
  return overlapsSection(findSites(root, CI_READING), CI_READING)['ci-reading']!
}

describe('the seal of the CI reading', () => {
  it('a CI read outside the port is red', { timeout: SCAN_TIMEOUT }, () => {
    for (const [label, line] of PLANTED) {
      const root = treeWith({ 'scripts/nodes/planted.ts': line, [PORT]: line, [BOARD]: line, [OWNER]: line, 'scripts/tests/planted.test.ts': line })
      expect(Object.keys(sitesPerFile(root)).sort(), label).toEqual([PORT, 'scripts/nodes/planted.ts', BOARD].sort())
    }
    expect(sitesPerFile(REPO_ROOT)).toEqual({})
  })

  it('the pure module is the owner the concept names', () => {
    expect(isOwnedBy(CI_READING[0]!, OWNER)).toBe(true)
    expect(isOwnedBy(CI_READING[0]!, PORT)).toBe(false)
  })

  it('the owner imports nothing but a node utility: no gh port, no spawn, no factory module', () => {
    const owner = readFileSync(path.join(REPO_ROOT, OWNER), 'utf8')

    expect([...owner.matchAll(IMPORT_SOURCE)].map(found => found[1])).toEqual(['node:util'])
  })

  it('snapshot keeps only a re-export of the reader record-verdict imports through it', () => {
    const snapshot = readFileSync(path.join(REPO_ROOT, 'scripts/ports/snapshot.ts'), 'utf8')

    expect(snapshot).toContain('export { ciOf } from \'./ci-reading.js\'')
    expect(snapshot).not.toContain('check-runs')
  })
})

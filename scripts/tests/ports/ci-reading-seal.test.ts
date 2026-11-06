import type { Site } from '../../contract/factory/overlaps.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS, isOwnedBy } from '../../contract/factory/concepts.js'
import { findSites } from '../../contract/factory/overlaps.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const OWNER = 'scripts/ports/ci-reading.ts'
const SCAN_TIMEOUT = 180_000
const CI_READING = [CONCEPTS.find(concept => concept.id === 'ci-reading')!]

interface Carrier {
  path: string
  reason: string
}

const CARRIERS: readonly Carrier[] = [
  { path: 'scripts/core/observations.ts', reason: 'the pure core writes into pr.observed the word takeSnapshot read through the port, and reads nothing itself; the core may not import a port at runtime, the question stands in the pull request of this card' },
  { path: 'src/commands/board/prs.ts', reason: 'the shipped CLI parses the gh JSON a person hands construct board; src/commands may not import scripts/ports, the question stands in the pull request of this card' },
  { path: 'src/commands/board/items.ts', reason: 'the same board reading: it passes the rollup of that JSON to prs.ts' },
]

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
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function sealOf(root: string, carriers: readonly Carrier[]): { outside: string[], stale: string[] } {
  const sites: Site[] = findSites(root, CI_READING)
  return {
    outside: [...new Set(sites.map(site => site.file).filter(file => !carriers.some(carrier => carrier.path === file)))],
    stale: carriers.filter(carrier => !sites.some(site => site.file === carrier.path)).map(carrier => carrier.path),
  }
}

describe('the seal of the CI reading', () => {
  it('a CI read outside the port is red', { timeout: SCAN_TIMEOUT }, () => {
    for (const [label, line] of PLANTED) {
      const root = treeWith({ 'scripts/nodes/planted.ts': line, [OWNER]: line, 'scripts/tests/planted.test.ts': line })
      expect(sealOf(root, []).outside, label).toEqual(['scripts/nodes/planted.ts'])
    }
    expect(sealOf(REPO_ROOT, CARRIERS).outside).toEqual([])
  })

  it('a carrier with no read left is red', { timeout: SCAN_TIMEOUT }, () => {
    const root = treeWith({ 'scripts/carried.ts': 'export function ciOf() { return 1 }', 'scripts/emptied.ts': 'export const nothing = 1' })
    const carriers = [{ path: 'scripts/carried.ts', reason: 'a sample' }, { path: 'scripts/emptied.ts', reason: 'a sample' }]

    expect(sealOf(root, carriers).stale).toEqual(['scripts/emptied.ts'])
    expect(sealOf(REPO_ROOT, CARRIERS).stale).toEqual([])
  })

  it('every carrier states its reason', () => {
    expect(CARRIERS.filter(carrier => carrier.reason.trim() === '')).toEqual([])
  })

  it('the port is the owner the concept names', () => {
    expect(isOwnedBy(CI_READING[0]!, OWNER)).toBe(true)
  })

  it('snapshot keeps only a re-export of the reader record-verdict imports through it', () => {
    const snapshot = readFileSync(path.join(REPO_ROOT, 'scripts/ports/snapshot.ts'), 'utf8')

    expect(snapshot).toContain('export { ciOf } from \'./ci-reading.js\'')
    expect(snapshot).not.toContain('check-runs')
  })
})

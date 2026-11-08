import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const PORT = 'scripts/ports/process-table.ts'
const PLANTED_FILE = 'scripts/nodes/planted.ts'
const SCAN_TIMEOUT = 180_000
const LIVENESS_WORDS = /\balive\b|\bliveness\b|\bisAlive\b|process\.kill\(/i
const PROCESS_CONCEPTS = CONCEPTS.filter(concept => concept.id === 'process-table' || concept.id === 'pid-liveness')

const PLANTED: readonly (readonly [string, string])[] = [
  ['a ps call', 'import { execFileSync } from \'node:child_process\'\nexport const rows = execFileSync(\'ps\', [\'-Ao\', \'pid=\'])'],
  ['an lsof call', 'import { execFileSync } from \'node:child_process\'\nexport const cwd = execFileSync(\'lsof\', [\'-p\', \'1\'])'],
  ['a kill zero', 'export function probe(pid: number) { process.kill(pid, 0) }'],
]

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'process-seal-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function filesWithSites(root: string): string[] {
  const section = overlapsSection(findSites(root, PROCESS_CONCEPTS), PROCESS_CONCEPTS)
  return [...new Set(Object.values(section).flatMap(perFile => Object.keys(perFile)))].sort()
}

describe('the seal of the process table', () => {
  it('a ps, lsof or kill zero outside the port is red', { timeout: SCAN_TIMEOUT }, () => {
    for (const [label, line] of PLANTED)
      expect(filesWithSites(treeWith({ [PLANTED_FILE]: line })), label).toEqual([PLANTED_FILE])
    expect(filesWithSites(REPO_ROOT)).toEqual([])
  })

  it('the live session detector sees machine-sessions and watch-process', { timeout: SCAN_TIMEOUT }, () => {
    const liveSession = CONCEPTS.filter(concept => concept.id === 'live-session')
    const root = treeWith({
      'scripts/core/machine-sessions.ts': 'export function sessionLiveness() { return 1 }',
      'scripts/ladder/watch-process.ts': 'export function isSessionAlive() { return true }',
    })

    expect(Object.keys(overlapsSection(findSites(root, liveSession), liveSession)['live-session']!).sort()).toEqual(['scripts/core/machine-sessions.ts', 'scripts/ladder/watch-process.ts'])
  })

  it('the port answers facts only and has no alive', () => {
    const port = readFileSync(path.join(REPO_ROOT, PORT), 'utf8')

    expect(port).not.toMatch(LIVENESS_WORDS)
  })
})

import type { Site } from '../../contract/factory/overlaps.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { findSites } from '../../contract/factory/overlaps.js'
import { constructCommand, pnpmCommand } from '../../core/owner-commands.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const CONCEPT_ID = 'owner-commands'
const OWNER = 'scripts/core/owner-commands.ts'
const PENDING_FILE = path.join(import.meta.dirname, 'owner-commands-pending.json')
const FACTORY_FILE = path.join(REPO_ROOT, 'contract', 'factory.json')
const TOLD_TO_THE_OWNER = `export const told = 'run pnpm lint yourself'\n`

type Counts = Readonly<Record<string, number>>

const concept = CONCEPTS.find(candidate => candidate.id === CONCEPT_ID)!

function countsOf(sites: readonly Site[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const { file } of sites)
    counts[file] = (counts[file] ?? 0) + 1
  return counts
}

function pastTheOwner(counts: Counts, pending: Counts): string[] {
  return Object.entries(counts).filter(([file, count]) => count > (pending[file] ?? 0)).map(([file, count]) => `${file}: ${count} > ${pending[file] ?? 0}`)
}

function sitesIn(root: string): Record<string, number> {
  return countsOf(findSites(root, [concept]))
}

function pending(): Counts {
  return JSON.parse(readFileSync(PENDING_FILE, 'utf8')) as Counts
}

const scratchRoots: string[] = []

function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'owner-commands-seal-'))
  scratchRoots.push(root)
  mkdirSync(path.join(root, 'scripts'))
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

afterAll(() => {
  scratchRoots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

describe('the owner of owner commands', () => {
  it('builds a command line from its program, its head and its arguments', () => {
    expect(pnpmCommand('handoff:write', 'handoff.md', 'draft.md')).toBe('pnpm handoff:write handoff.md draft.md')
    expect(pnpmCommand('board')).toBe('pnpm board')
    expect(constructCommand('doctor', '--dir', '.')).toBe('construct doctor --dir .')
    expect(constructCommand('intake', '--admit', 1797)).toBe('construct intake --admit 1797')
  })

  it('is the owner the factory contract names', () => {
    expect(concept.owner).toBe(OWNER)
    expect(concept.ownerExists).toBe(true)
  })
})

describe('the owner-commands seal', () => {
  it('an owner command literal outside the owner is red', () => {
    const root = fixtureTree({
      [OWNER]: TOLD_TO_THE_OWNER,
      'scripts/window/pending.ts': TOLD_TO_THE_OWNER,
      'scripts/window/grown.ts': `${TOLD_TO_THE_OWNER}${TOLD_TO_THE_OWNER}`,
      'src/planted.ts': TOLD_TO_THE_OWNER,
    })
    const recorded = { 'scripts/window/pending.ts': 1, 'scripts/window/grown.ts': 1 }

    expect(pastTheOwner(sitesIn(root), recorded)).toEqual(['scripts/window/grown.ts: 2 > 1', 'src/planted.ts: 1 > 0'])
  })

  it('no file holds more owner command literals than the pending table records', () => {
    expect(pastTheOwner(sitesIn(REPO_ROOT), pending())).toEqual([])
  })

  it('every overlap of the concept in the factory contract stands in the pending table', () => {
    const factory = JSON.parse(readFileSync(FACTORY_FILE, 'utf8')) as { overlaps: Record<string, Counts> }

    expect(pastTheOwner(factory.overlaps[CONCEPT_ID]!, pending())).toEqual([])
  })

  it('every pending row is a positive count', () => {
    expect(Object.entries(pending()).filter(([, count]) => !Number.isInteger(count) || count < 1)).toEqual([])
  })
})

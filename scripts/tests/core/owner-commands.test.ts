import type { Site } from '../../contract/factory/overlaps.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { findSites } from '../../contract/factory/overlaps.js'
import { ADMIT_COMMAND, constructCommand, isOwnerMoveRequest, npxConstructCommand, OWNER_MOVE_REQUESTS, OWNER_MOVES, ownerMoveCommand, ownerMoveOf, ownerMoveRequestOf, ownerMoveUsage, pnpmCommand, QUALITY_COMMAND } from '../../core/owner-commands.js'
import { admitCommandOf } from '../../core/queue.js'
import { isRequestKind, requestOf, USAGE } from '../../window/window-requests.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const CONCEPT_ID = 'owner-commands'
const OWNER = 'scripts/core/owner-commands.ts'
const PENDING_FILE = path.join(import.meta.dirname, 'owner-commands-pending.json')
const FACTORY_FILE = path.join(REPO_ROOT, 'contract', 'factory.json')
const LAYERS_TOLD_THROUGH_THE_OWNER = /^scripts\/(?:ci|cli|composition|contract|core|docs|intake|model|release-notes|release)\//
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
    expect(npxConstructCommand('attach', '--dir', '\'/tmp/a b\'')).toBe('npx mikoshi-construct attach --dir \'/tmp/a b\'')
    expect(QUALITY_COMMAND).toBe('pnpm run quality')
  })

  it('holds the admit command the queue tells the owner to run, with or without a lane', () => {
    expect(ADMIT_COMMAND).toBe('pnpm intake --admit')
    expect(admitCommandOf(1802, 'lane-2')).toBe('pnpm intake --admit <parking>/lane-2/1802.md')
    expect(admitCommandOf(1802, '')).toBe('pnpm intake --admit <parking>/1802.md')
    expect(admitCommandOf(1802, null)).toBe('pnpm intake --admit <parking>/1802.md')
  })

  it('the four owner moves are commands of the owner-commands contract', () => {
    expect(OWNER_MOVES).toEqual(['stop', 'launch', 'takeover', 'requeue'])
    expect(OWNER_MOVES.map(move => ownerMoveCommand(move, move === 'requeue' ? 'launch:1784' : 1828))).toEqual([
      'pnpm bus:request owner.stop --card 1828',
      'pnpm bus:request owner.launch --card 1828',
      'pnpm bus:request owner.takeover --card 1828',
      'pnpm bus:request owner.requeue --task launch:1784',
    ])
    expect(OWNER_MOVE_REQUESTS.every(kind => isRequestKind(kind) && isOwnerMoveRequest(kind))).toBe(true)
    expect(OWNER_MOVE_REQUESTS.map(ownerMoveOf)).toEqual([...OWNER_MOVES])
    expect(OWNER_MOVES.map(move => requestOf(ownerMoveCommand(move, move === 'requeue' ? 'launch:1784' : 1828).split(' ').slice(2)))).toEqual([
      { kind: 'owner.stop', card: 1828 },
      { kind: 'owner.launch', card: 1828 },
      { kind: 'owner.takeover', card: 1828 },
      { kind: 'owner.requeue', task_key: 'launch:1784' },
    ])
    expect(ownerMoveRequestOf('owner.stop', ['owner.stop', '--card', '#1828'])).toEqual({ kind: 'owner.stop', card: 1828 })
    expect(ownerMoveRequestOf('owner.stop', ['owner.stop', '--card', 'none'])).toBeNull()
    expect(ownerMoveRequestOf('owner.requeue', ['owner.requeue'])).toBeNull()
    expect(USAGE).toContain(ownerMoveUsage())
    expect(isOwnerMoveRequest('takeover')).toBe(false)
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

  it('the layers ci, cli, composition, contract, core, docs, intake, model, release-notes and release hold no pending row', () => {
    expect(Object.keys(pending()).filter(file => LAYERS_TOLD_THROUGH_THE_OWNER.test(file))).toEqual([])
  })

  it('every pending row is a positive count', () => {
    expect(Object.entries(pending()).filter(([, count]) => !Number.isInteger(count) || count < 1)).toEqual([])
  })
})

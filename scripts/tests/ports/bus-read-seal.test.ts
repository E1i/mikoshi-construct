import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS, isOwnedBy } from '../../contract/factory/concepts.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'
import { overlapNumbers, ratchetBreaks, readRatchet } from '../../contract/ratchet.js'
import { BUS_TABLES } from '../../ports/bus-read.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const PORT = 'scripts/ports/bus-read.ts'
const NODE = 'scripts/nodes/planted.ts'
const BOARD = 'src/commands/board/planted.ts'
const KEY = 'overlaps:bus-read'
const SCAN_TIMEOUT = 180_000
const BUS_READ = [CONCEPTS.find(concept => concept.id === 'bus-read')!]

type SitesPerFile = Record<string, number>

const PLANTED: readonly (readonly [string, string])[] = [
  ['a select over events', 'export const sql = \'SELECT id FROM events WHERE type = ?\''],
  ['a join over a projection', 'export const sql = `SELECT c.card_id FROM x JOIN cards c ON c.card_id = x.id`'],
  ['a count over tasks', 'export const sql = "SELECT count(*) AS n FROM tasks"'],
  ['a quoted table', 'export const sql = \'SELECT * FROM "owner_waits"\''],
]

const NOT_A_READ: readonly (readonly [string, string])[] = [
  ['a write that selects', 'export const sql = \'INSERT INTO cards (card_id) SELECT card_id FROM events\''],
  ['a table outside the bus', 'export const sql = \'SELECT name FROM sqlite_master\''],
  ['prose in lower case', 'export const line = \'read from events\''],
]

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-read-seal-'))
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
  return overlapsSection(findSites(root, BUS_READ), BUS_READ)['bus-read']!
}

describe('the seal of the bus read', () => {
  it('sql on a bus table outside the port is red', () => {
    for (const [label, line] of PLANTED) {
      const root = treeWith({ [NODE]: line, [BOARD]: line, [PORT]: line, 'scripts/tests/planted.test.ts': line })
      expect(sitesPerFile(root), label).toEqual({ [NODE]: 1, [BOARD]: 1 })
    }
    for (const [label, line] of NOT_A_READ)
      expect(sitesPerFile(treeWith({ [NODE]: line })), label).toEqual({})
  })

  it('the port is the owner the concept names, and its tables are the tables of the bus section', () => {
    const { bus } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract', 'factory.json'), 'utf8')) as { bus: { tables: Record<string, string[]> } }

    expect(isOwnedBy(BUS_READ[0]!, PORT)).toBe(true)
    expect([...BUS_TABLES]).toEqual(Object.keys(bus.tables).sort())
  })

  it('the bus-read concept in the ratchet only falls', { timeout: SCAN_TIMEOUT }, () => {
    const recorded = readRatchet(REPO_ROOT)
    const now = overlapNumbers({ 'bus-read': sitesPerFile(REPO_ROOT) })
    const held = recorded[KEY]

    expect(held).toBeGreaterThan(0)
    expect(now[KEY]).toBe(held)
    expect(ratchetBreaks({ [KEY]: held! }, { [KEY]: held! + 1 })).toEqual([expect.stringContaining(`${KEY} grew from ${held} to ${held! + 1}`)])
    expect(ratchetBreaks({ [KEY]: held! }, { [KEY]: held! - 1 })).toEqual([expect.stringContaining(`${KEY} went down from ${held}`)])
  })
})

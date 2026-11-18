import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SCANNED_ROOTS = ['src', 'scripts']
const TEST_ROOTS = new Set(['scripts/tests', 'tests'])
const SOURCE_FILE = /\.(?:ts|mts|mjs|js)$/
const WRITE = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:\$\{(\w+)\}|(\w+))/g

const TABLE_OF_CONSTANT: Readonly<Record<string, string>> = {
  NODE_CURSORS: 'node_cursors',
  HEARTBEATS: 'heartbeats',
  CARDS: 'cards',
  OWNER_WAITS: 'owner_waits',
}

const WRITERS_OF_TABLE: Readonly<Record<string, readonly string[]>> = {
  node_cursors: ['scripts/core/node.ts'],
  heartbeats: ['scripts/core/db.ts'],
}

function sourceFiles(relative: string): string[] {
  if (TEST_ROOTS.has(relative))
    return []
  return readdirSync(path.join(ROOT, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(relative, entry.name)
    if (entry.isDirectory())
      return entry.name === 'node_modules' ? [] : sourceFiles(child)
    return SOURCE_FILE.test(entry.name) ? [child] : []
  })
}

function writtenTables(text: string): Set<string> {
  const tables = new Set<string>()
  for (const match of text.matchAll(WRITE)) {
    const table = match[1] === undefined ? match[2] : TABLE_OF_CONSTANT[match[1]]
    if (table !== undefined)
      tables.add(table)
  }
  return tables
}

function writersOf(table: string): string[] {
  return SCANNED_ROOTS.flatMap(sourceFiles).filter(file => writtenTables(readFileSync(path.join(ROOT, file), 'utf8')).has(table)).sort()
}

describe('one writer module per bus table', () => {
  for (const [table, writers] of Object.entries(WRITERS_OF_TABLE)) {
    it(`${table} is written only by ${writers.join(', ')}`, () => {
      expect(writersOf(table)).toEqual([...writers].sort())
    })
  }

  it('reads a write through the table constant as a write of the table', () => {
    const constant = (name: string): string => `$\{${name}}`
    expect([...writtenTables(`db.prepare(\`UPDATE ${constant('NODE_CURSORS')} SET event_id = ?\`)`)]).toEqual(['node_cursors'])
    expect([...writtenTables('INSERT OR IGNORE INTO heartbeats (a) VALUES (1)')]).toEqual(['heartbeats'])
    expect([...writtenTables(`DELETE FROM ${constant('OWNER_WAITS')} WHERE id = ?`)]).toEqual(['owner_waits'])
  })
})

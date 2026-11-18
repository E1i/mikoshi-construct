import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SCANNED_ROOTS = ['src', 'scripts']
const TEST_DIRECTORY = /(?:^|\/)tests\//
const SOURCE_FILE = /\.(?:ts|mts|mjs|js)$/
const TABLE_CONSTANT = /\bconst\s+(\w+)\s*=\s*'(\w+)'/g
const WRITE_STATEMENT = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(\$\{\s*(\w+)\s*\}|\w+)/gi

const WRITERS_BY_TABLE: Readonly<Record<string, readonly string[]>> = {
  heartbeats: ['scripts/core/db.ts'],
}

function sourceFiles(): string[] {
  return SCANNED_ROOTS.flatMap(root => readdirSync(path.join(ROOT, root), { recursive: true, encoding: 'utf8' })
    .map(file => `${root}/${file.split(path.sep).join('/')}`))
    .filter(file => SOURCE_FILE.test(file) && !TEST_DIRECTORY.test(file))
}

function tableConstants(texts: ReadonlyMap<string, string>): Map<string, Set<string>> {
  const constants = new Map<string, Set<string>>()
  for (const text of texts.values()) {
    for (const [, name, value] of text.matchAll(TABLE_CONSTANT))
      constants.set(name!, (constants.get(name!) ?? new Set()).add(value!))
  }
  return constants
}

function writtenTables(text: string, constants: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const tables = new Set<string>()
  for (const [, target, constant] of text.matchAll(WRITE_STATEMENT)) {
    const resolved = constant === undefined ? [target!] : [...constants.get(constant) ?? []]
    resolved.forEach(table => tables.add(table))
  }
  return tables
}

function writersOf(table: string): string[] {
  const texts = new Map(sourceFiles().map(file => [file, readFileSync(path.join(ROOT, file), 'utf8')]))
  const constants = tableConstants(texts)
  return [...texts].filter(([, text]) => writtenTables(text, constants).has(table)).map(([file]) => file).sort()
}

describe('one writer module per bus table', () => {
  for (const [table, writers] of Object.entries(WRITERS_BY_TABLE)) {
    it(`${table} is written only by ${writers.join(', ')}`, () => {
      expect(writersOf(table)).toEqual([...writers].sort())
    })
  }
})

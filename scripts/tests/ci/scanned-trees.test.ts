import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCANNED_TREES } from '../../ci/layers.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const TEST_DIRS = ['tests', path.join('scripts', 'tests')]
const THIS_FILE = path.relative(REPO_ROOT, import.meta.filename)
const WALKS_A_TREE = /\b(?:readdirSync|globSync)\b/
const NAMES_A_TREE = /(?:REPO_ROOT|import\.meta\.dirname)[^)\n]*['"`](?:src|scripts)['"`](?:,\s*['"`][\w-]+['"`])*\)/

function testFiles(): string[] {
  return TEST_DIRS.flatMap(dir =>
    readdirSync(path.join(REPO_ROOT, dir), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.test.ts'))
      .map(entry => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name))),
  )
}

describe('the tests that scan a tree without importing it are all named in SCANNED_TREES', () => {
  it('lists every test that walks src or scripts', () => {
    const listed = new Set(Object.values(SCANNED_TREES).flat())
    const scanners = testFiles()
      .filter(file => file !== THIS_FILE)
      .filter((file) => {
        const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
        return WALKS_A_TREE.test(text) && NAMES_A_TREE.test(text)
      })
    expect(scanners.filter(file => !listed.has(file))).toEqual([])
  })
})

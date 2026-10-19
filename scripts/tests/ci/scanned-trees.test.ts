import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCANNED_TREES } from '../../ci/layers.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const TEST_DIRS = ['tests', path.join('scripts', 'tests')]
const THIS_FILE = path.relative(REPO_ROOT, import.meta.filename)
const WALKS_A_TREE = /\b(?:readdirSync|globSync)\b|['"`]ls-files['"`]/
const NAMES_A_TREE = /\b(?:\w*[Rr]oot|\w*dirname)\b[^)\n]*['"`](?:src|scripts)(?:\/[\w-]+)*['"`](?:,\s*['"`][\w-]+['"`])*\)|\b\w*ROOTS\s*=\s*\[[^\]\n]*['"`](?:src|scripts)(?:\/[\w-]+)*['"`]/

function testFiles(): string[] {
  return TEST_DIRS.flatMap(dir =>
    readdirSync(path.join(REPO_ROOT, dir), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.test.ts'))
      .map(entry => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name))),
  )
}

describe('the detector of a tree-naming path', () => {
  it('sees a root variable of any root-like name joined to a src or scripts path literal, and not a file or a temp directory', () => {
    expect(NAMES_A_TREE.test('readdirSync(path.join(root, \'scripts/ghosts\'))')).toBe(true)
    expect(NAMES_A_TREE.test('readdirSync(path.join(repoRoot, \'src\', \'commands\'))')).toBe(true)
    expect(NAMES_A_TREE.test('path.join(REPO_ROOT, \'scripts\', \'morse\', \'cli.ts\')')).toBe(false)
    expect(NAMES_A_TREE.test('path.join(dir, \'src\')')).toBe(false)
  })

  it('sees a git ls-files walk over a list of roots that names a src or scripts tree', () => {
    expect(WALKS_A_TREE.test('execFileSync(\'git\', [\'ls-files\', \'--\', ...SCANNED_ROOTS])')).toBe(true)
    expect(NAMES_A_TREE.test('const SCANNED_ROOTS = [\'architecture\', \'.claude\', \'scripts/shift\']')).toBe(true)
    expect(NAMES_A_TREE.test('const SCANNED_ROOTS = [\'architecture\', \'.claude\']')).toBe(false)
  })
})

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

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCANNED_TREES } from '../../../src/card/covering-tests.js'
import { namesATree, scansATree, walksATree } from '../../ci/tree-scanners.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const TEST_DIRS = ['tests', path.join('scripts', 'tests')]
const THIS_FILE = path.relative(REPO_ROOT, import.meta.filename)

function testFiles(): string[] {
  return TEST_DIRS.flatMap(dir =>
    readdirSync(path.join(REPO_ROOT, dir), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.test.ts'))
      .map(entry => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name))),
  )
}

function scanners(): string[] {
  return testFiles()
    .filter(file => file !== THIS_FILE)
    .filter(file => scansATree(readFileSync(path.join(REPO_ROOT, file), 'utf8')))
}

describe('the detector of a tree-naming path', () => {
  it('sees a root variable of any root-like name joined to a src or scripts path literal, and not a file or a temp directory', () => {
    expect(namesATree('readdirSync(path.join(root, \'scripts/ghosts\'))')).toBe(true)
    expect(namesATree('readdirSync(path.join(repoRoot, \'src\', \'commands\'))')).toBe(true)
    expect(namesATree('readdirSync(path.join(REPO_ROOT, \'scripts\', \'bus\'))')).toBe(true)
    expect(namesATree('path.join(REPO_ROOT, \'scripts\', \'morse\', \'cli.ts\')')).toBe(false)
    expect(namesATree('path.join(dir, \'src\')')).toBe(false)
  })

  it('sees a git ls-files walk over a list of roots that names a src or scripts tree', () => {
    expect(walksATree('execFileSync(\'git\', [\'ls-files\', \'--\', ...SCANNED_ROOTS])')).toBe(true)
    expect(namesATree('const SCANNED_ROOTS = [\'architecture\', \'.claude\', \'scripts/shift\']')).toBe(true)
    expect(namesATree('const SCANNED_ROOTS = [\'architecture\', \'.claude\']')).toBe(false)
  })

  it('sees a walk over a literal list of the scripts and src trees', () => {
    expect(scansATree('[\'scripts\', \'src\'].flatMap(root => readdirSync(path.join(REPO_ROOT, root), { recursive: true }))')).toBe(true)
    expect(namesATree('[\'docs\', \'templates\'].flatMap(root => readdirSync(path.join(REPO_ROOT, root)))')).toBe(false)
  })
})

describe('the tests that scan a tree without importing it are all named in SCANNED_TREES', () => {
  it('lists every test that walks src or scripts', () => {
    const listed = new Set(Object.values(SCANNED_TREES).flat())
    expect(scanners().filter(file => !listed.has(file))).toEqual([])
  })
})

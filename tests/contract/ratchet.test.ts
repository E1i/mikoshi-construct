import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bigFileNumbers, generateNumbers, overlapNumbers, ratchetBreaks, readRatchet, renderRatchet, thresholdOf } from '../../scripts/contract/ratchet.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const GENERATION_TIMEOUT = 180_000
const SITE_KEY = 'overlaps:ci-reading'
const BIG_FILE_KEY = 'lines:scripts/big.ts'
const LINE_SCOPE_KEY = 'lines-scope:non-test-code-in-scripts-and-src'
const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function treeWithFile(lines: number): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ratchet-'))
  roots.push(root)
  for (const tree of ['scripts', 'src', 'templates', 'tests'])
    mkdirSync(path.join(root, tree))
  writeFileSync(path.join(root, 'scripts', 'big.ts'), linesOf(lines))
  return root
}

function linesOf(count: number): string {
  return Array.from({ length: count }).fill('export {}').join('\n')
}

describe('the ratchet', () => {
  it('a concept site that grows above the baseline is red', () => {
    const recorded = overlapNumbers({ 'ci-reading': { 'scripts/ports/gh.ts': 3 } })
    expect(ratchetBreaks(recorded, { [SITE_KEY]: 4 })).toEqual([expect.stringContaining(`${SITE_KEY} grew from 3 to 4`)])
    expect(ratchetBreaks(recorded, recorded)).toEqual([])
  })

  it('a site added in another file raises the concept sum and is red', () => {
    const recorded = overlapNumbers({ 'ci-reading': { 'scripts/ports/gh.ts': 3 } })
    const added = overlapNumbers({ 'ci-reading': { 'scripts/ports/gh.ts': 3, 'scripts/new.ts': 1 } })
    expect(ratchetBreaks(recorded, added)).toEqual([expect.stringContaining(`${SITE_KEY} grew from 3 to 4`)])
  })

  it('a site moved between files with the concept sum unchanged is not growth', () => {
    const recorded = overlapNumbers({ 'ci-reading': { 'scripts/ports/gh.ts': 3, 'scripts/ports/snapshot.ts': 1 } })
    const movedBetween = overlapNumbers({ 'ci-reading': { 'scripts/ports/gh.ts': 2, 'scripts/ports/snapshot.ts': 2 } })
    const movedToNewFile = overlapNumbers({ 'ci-reading': { 'scripts/ports/gh.ts': 2, 'scripts/ports/snapshot.ts': 1, 'scripts/new.ts': 1 } })
    expect(movedBetween).toEqual(recorded)
    expect(ratchetBreaks(recorded, movedBetween)).toEqual([])
    expect(ratchetBreaks(recorded, movedToNewFile)).toEqual([])
  })

  it('the record holds one key per concept and no key per file', () => {
    const section = { 'ci-reading': { 'scripts/ports/gh.ts': 3, 'scripts/ports/snapshot.ts': 1 }, 'git': { 'src/detect/git.ts': 2 } }
    expect(overlapNumbers(section)).toEqual({ [SITE_KEY]: 4, 'overlaps:git': 2 })
    const overlapKeys = Object.keys(readRatchet(REPO_ROOT)).filter(key => key.startsWith('overlaps:'))
    expect(overlapKeys).toContain(SITE_KEY)
    expect(overlapKeys.filter(key => !/^overlaps:[^:/]+$/.test(key))).toEqual([])
  })

  it('a big file that grows above the baseline is red', () => {
    const atTheLine = bigFileNumbers(treeWithFile(800), 800)
    expect(atTheLine).toEqual({})
    const grown = bigFileNumbers(treeWithFile(801), 800)
    expect(grown).toEqual({ [BIG_FILE_KEY]: 801 })
    expect(ratchetBreaks(atTheLine, grown)).toEqual([expect.stringContaining(`${BIG_FILE_KEY} grew from 0 to 801`)])
  })

  it('only non-test code in scripts and src counts: a big test, a tests file, a fixture and a template do not', () => {
    const root = treeWithFile(1)
    for (const folder of [['scripts', 'tests'], ['scripts', 'fixtures'], ['tests', 'fixtures']])
      mkdirSync(path.join(root, ...folder))
    writeFileSync(path.join(root, 'scripts', 'big.test.ts'), linesOf(801))
    writeFileSync(path.join(root, 'scripts', 'tests', 'big.ts'), linesOf(801))
    writeFileSync(path.join(root, 'scripts', 'fixtures', 'big.ts'), linesOf(801))
    writeFileSync(path.join(root, 'tests', 'big.ts'), linesOf(801))
    writeFileSync(path.join(root, 'tests', 'fixtures', 'big.mjs'), linesOf(801))
    writeFileSync(path.join(root, 'templates', 'big.ts'), linesOf(801))
    writeFileSync(path.join(root, 'templates', 'big.ts.eta'), linesOf(801))
    writeFileSync(path.join(root, 'src', 'big.ts'), linesOf(801))
    expect(Object.keys(bigFileNumbers(root, 800))).toEqual(['lines:src/big.ts'])
  })

  it('the record holds the line scope: dropping the key is red, and the generated numbers carry it', () => {
    const generated = generateNumbers(treeWithFile(1), 800)
    expect(generated[LINE_SCOPE_KEY]).toBe(1)
    expect(readRatchet(REPO_ROOT)[LINE_SCOPE_KEY]).toBe(1)
    expect(ratchetBreaks({ threshold: 800 }, generated)).toEqual([expect.stringContaining(`${LINE_SCOPE_KEY} grew from 0 to 1`)])
  })

  it('a number below the baseline is red until the baseline is lowered', () => {
    const recorded = { [SITE_KEY]: 3, [BIG_FILE_KEY]: 900 }
    const lowered = { [SITE_KEY]: 2 }
    expect(ratchetBreaks(recorded, lowered)).toEqual([
      expect.stringContaining(`${BIG_FILE_KEY} went down from 900 to 0`),
      expect.stringContaining(`${SITE_KEY} went down from 3 to 2`),
    ])
    expect(ratchetBreaks(lowered, lowered)).toEqual([])
  })

  it('the recorded baseline matches this tree', { timeout: GENERATION_TIMEOUT }, () => {
    const recorded = readRatchet(REPO_ROOT)
    expect(ratchetBreaks(recorded, generateNumbers(REPO_ROOT, thresholdOf(recorded)))).toEqual([])
  })

  it('the record holds one key and one number on a line, the shape the merge policy reads from a diff', () => {
    const lines = renderRatchet(readRatchet(REPO_ROOT)).trimEnd().split('\n').slice(1, -1)
    expect(lines.filter(line => !/^ {2}"[^"]+": \d+,?$/.test(line))).toEqual([])
  })

  it('a record without a threshold is refused', () => {
    expect(() => thresholdOf({})).toThrow('holds no threshold')
  })
})

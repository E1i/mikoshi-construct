import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bigFileNumbers, generateNumbers, overlapNumbers, ratchetBreaks, readRatchet, renderRatchet, thresholdOf } from '../../scripts/contract/ratchet.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const GENERATION_TIMEOUT = 180_000
const SITE_KEY = 'overlaps:ci-reading:scripts/ports/gh.ts'
const BIG_FILE_KEY = 'lines:scripts/big.ts'
const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function treeWithFile(lines: number): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ratchet-'))
  roots.push(root)
  mkdirSync(path.join(root, 'scripts'))
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'scripts', 'big.ts'), Array.from({ length: lines }).fill('export {}').join('\n'))
  return root
}

describe('the ratchet', () => {
  it('a concept site that grows above the baseline is red', () => {
    const recorded = overlapNumbers({ 'ci-reading': { 'scripts/ports/gh.ts': 3 } })
    expect(ratchetBreaks(recorded, { [SITE_KEY]: 4 })).toEqual([expect.stringContaining(`${SITE_KEY} grew from 3 to 4`)])
    expect(ratchetBreaks(recorded, { ...recorded, 'overlaps:ci-reading:scripts/new.ts': 1 })).toEqual([expect.stringContaining('scripts/new.ts grew from 0 to 1')])
    expect(ratchetBreaks(recorded, recorded)).toEqual([])
  })

  it('a big file that grows above the baseline is red', () => {
    const atTheLine = bigFileNumbers(treeWithFile(800), 800)
    expect(atTheLine).toEqual({})
    const grown = bigFileNumbers(treeWithFile(801), 800)
    expect(grown).toEqual({ [BIG_FILE_KEY]: 801 })
    expect(ratchetBreaks(atTheLine, grown)).toEqual([expect.stringContaining(`${BIG_FILE_KEY} grew from 0 to 801`)])
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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const README = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8')
const PUBLISHED_VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version as string

const CLAIM_SHAPES = [
  /\bv(\d+\.\d+(?:\.\d+)?)/g,
  /\bversion\s+(\d+\.\d+(?:\.\d+)?)/gi,
  /(?<![\w.])(\d+\.\d+\.\d+)(?![\w.])/g,
  /\bmikoshi-construct@(\S+)/g,
]

function versionClaimsIn(text: string): string[] {
  return CLAIM_SHAPES.flatMap(shape => [...text.matchAll(shape)].map(match => match[1]))
}

describe('the version the front page claims', () => {
  it('agrees with the version this package publishes, on every claim the README makes', () => {
    for (const claim of versionClaimsIn(README))
      expect(claim, `README claims version ${claim}; package.json publishes ${PUBLISHED_VERSION}`).toBe(PUBLISHED_VERSION)
  })

  it('reads a claim where one is written, so a README that names no version passes on its silence and not on a blind detector', () => {
    expect(versionClaimsIn('> **v0.3.** Presets `node-backend` and `monorepo`.')).toEqual(['0.3'])
    expect(versionClaimsIn('materialized by `mikoshi-construct` version 0.1.0')).toEqual(['0.1.0', '0.1.0'])
    expect(versionClaimsIn('npx mikoshi-construct@0.9.1 init')).toEqual(['0.9.1', '0.9.1'])
  })

  it('reads a measurement as a measurement, so the token counts are not mistaken for a version', () => {
    expect(versionClaimsIn('Two `high` tasks cost 14.19M and 14.14M, and one `medium` 5.9M.')).toEqual([])
  })
})

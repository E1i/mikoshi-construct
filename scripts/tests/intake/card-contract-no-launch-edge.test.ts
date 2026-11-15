import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CARD_PATH_REASON } from '../../../src/card/grammar.js'
import * as treePr from '../../nodes/launch/tree-pr.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const CARD_CONTRACT = path.join(ROOT, 'scripts/intake/card-contract.ts')
const IMPORT_SOURCE = /\bfrom\s+'([^']+)'/g

function importSourcesOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT_SOURCE)].map(match => path.resolve(path.dirname(file), match[1]!))
}

describe('the card contract reads the path reason from the card model, not from the launch node', () => {
  it('scripts/intake/card-contract.ts imports nothing under scripts/nodes/launch/', () => {
    const launch = path.join(ROOT, 'scripts/nodes/launch')
    expect(importSourcesOf(CARD_CONTRACT).filter(source => source.startsWith(`${launch}${path.sep}`))).toEqual([])
  })

  it('the path reason pattern is exported from src/card/grammar.ts and no longer from tree-pr.ts', () => {
    expect(CARD_PATH_REASON).toBeInstanceOf(RegExp)
    expect('CARD_PATH_REASON' in treePr).toBe(false)
  })

  it('reads the path reason from a card body with a Path (D-76) line', () => {
    const body = ['#1 some-card [implement/construct/S/cheap/auto]', 'Path (D-76):   cheap — one module, its test  ', 'runs: []'].join('\n')
    expect(CARD_PATH_REASON.exec(body)?.[1]?.trim()).toBe('cheap — one module, its test')
    expect(CARD_PATH_REASON.exec('#1 some-card\nPath: cheap')).toBeNull()
  })
})

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const BUS_TO_CARD_MODEL = 'boundary:bus->card-model'
const LEGACY_HISTORY = 'scripts/core/legacy-history.ts'
const SRC_CARD = 'src/card/'

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8')
}

function importLines(source: string): string[] {
  return source.split('\n').filter(line => /\bfrom\s/.test(line))
}

describe('legacy history reads no card model', () => {
  it('bus->card-model is gone from contract/ratchet.json and legacy-history.ts imports nothing from src/card', () => {
    const ratchet = JSON.parse(read('contract/ratchet.json')) as Record<string, number>
    expect(ratchet[BUS_TO_CARD_MODEL] ?? 0).toBe(0)
    expect(BUS_TO_CARD_MODEL in ratchet).toBe(false)
    const fromSrcCard = importLines(read(LEGACY_HISTORY)).filter(line => line.includes(SRC_CARD))
    expect(importLines(read(LEGACY_HISTORY)).length).toBeGreaterThan(0)
    expect(fromSrcCard).toEqual([])
  })
})

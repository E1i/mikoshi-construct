import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

const CARD_GRAMMAR = ['scripts/policy/touch-scope.ts', 'scripts/policy/placement-growth.ts', 'scripts/policy/derived-files.ts']

const CLEARED_ROWS = ['intake', 'quality', 'card-model', 'plan', 'project'].map(from => `boundary:${from}->rules`)

const CARD_RECORD_ROW = 'boundary:card-record->rules'

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')) as T
}

function declaredPaths(module: string): string[] {
  return readJson<{ paths: string[] }>(`declarations/modules/${module}.json`).paths
}

describe('the touch scope, placement growth and derived-files rules are card grammar, owned by card-model', () => {
  it('card-model declares the three files and rules declares none of them', () => {
    expect(declaredPaths('card-model')).toEqual(expect.arrayContaining(CARD_GRAMMAR))
    for (const file of CARD_GRAMMAR)
      expect(declaredPaths('rules')).not.toContain(file)
  })

  it('the recorded ratchet holds no cleared row and card-record into rules at one', () => {
    const recorded = readJson<Record<string, number>>('contract/ratchet.json')
    for (const row of CLEARED_ROWS)
      expect(recorded[row], row).toBeUndefined()
    expect(recorded[CARD_RECORD_ROW]).toBe(1)
  })
})

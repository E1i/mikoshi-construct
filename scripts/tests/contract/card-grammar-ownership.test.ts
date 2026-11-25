import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../contract/factory/modules.js'
import { boundaryNumbers, boundaryReport } from '../../contract/module-graph/boundary.js'
import { readRatchet } from '../../contract/ratchet.js'
import { FACTORY_ROOT } from '../../core/factory-paths.js'

const CARD_GRAMMAR = ['policy/touch-scope.ts', 'policy/placement-growth.ts', 'policy/derived-files.ts'].map(file => `${FACTORY_ROOT}/${file}`)

const CLEARED_ROWS = ['intake', 'quality', 'card-model', 'plan', 'project'].map(from => `boundary:${from}->rules`)

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

const CARD_RECORD_ROW = 'boundary:card-record->rules'

describe('the touch scope, placement growth and derived-files rules are card grammar, owned by card-model', () => {
  it('card-model owns the three files and rules owns none of them', () => {
    expect(MODULE_GRAPH.modules['card-model']!.owns).toEqual(expect.arrayContaining(CARD_GRAMMAR))
    for (const file of CARD_GRAMMAR)
      expect(MODULE_GRAPH.modules.rules!.owns).not.toContain(file)
  })

  it('the measured boundary rows into rules that the move clears count zero, and card-record into rules counts one', () => {
    const measured = boundaryNumbers(boundaryReport().violations)
    for (const row of CLEARED_ROWS)
      expect(measured[row] ?? 0, row).toBe(0)
    expect(measured[CARD_RECORD_ROW]).toBe(1)
  })

  it('the recorded ratchet holds no cleared row and card-record into rules at one', () => {
    const recorded = readRatchet(REPO_ROOT)
    for (const row of CLEARED_ROWS)
      expect(recorded[row], row).toBeUndefined()
    expect(recorded[CARD_RECORD_ROW]).toBe(1)
  })
})

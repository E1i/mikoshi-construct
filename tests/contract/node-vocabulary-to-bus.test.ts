import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const BOUNDARY_PREFIX = 'boundary:'
const ROWS_AT_ZERO = ['node-close->node-review', 'node-merge->node-review', 'node-restart->node-review', 'node-update->node-merge'].map(edge => `${BOUNDARY_PREFIX}${edge}`)
const RESTART_TO_WINDOW = `${BOUNDARY_PREFIX}node-restart->window`
const RESTART_TO_WINDOW_AFTER_THE_MOVE = 1

const recorded = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/ratchet.json'), 'utf8')) as Record<string, number>

describe('the node vocabulary lives in the bus, as the ratchet that tests/contract/ratchet.test.ts holds equal to the tree records it', () => {
  it('the node rows the vocabulary move empties are gone from the ratchet', () => {
    expect(ROWS_AT_ZERO.filter(row => row in recorded)).toEqual([])
  })

  it('node-restart->window keeps only the one import that stays', () => {
    expect(recorded[RESTART_TO_WINDOW]).toBe(RESTART_TO_WINDOW_AFTER_THE_MOVE)
  })
})

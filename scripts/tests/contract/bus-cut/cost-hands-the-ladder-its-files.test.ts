import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const RATCHET = 'contract/ratchet.json'
const ROWS_THE_LEDGER_FILES_LEAVE = ['boundary:session->cost', 'boundary:node-close->cost', 'boundary:release->cost'] as const
const TRANSITIONAL_LADDER_ROWS = ['boundary:ladder->cost', 'boundary:ladder->release'] as const

function ratchetRows(): Record<string, number> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, RATCHET), 'utf8')) as Record<string, number>
}

function present(rows: readonly string[]): string[] {
  const ratchet = ratchetRows()
  return rows.filter(row => (ratchet[row] ?? 0) > 0)
}

it('session->cost, node-close->cost and release->cost are gone from contract/ratchet.json', () => {
  expect(present(ROWS_THE_LEDGER_FILES_LEAVE)).toEqual([])
})

it('ladder->cost and ladder->release are gone from contract/ratchet.json', () => {
  expect(present(TRANSITIONAL_LADDER_ROWS)).toEqual([])
})

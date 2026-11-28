import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const LADDER_DECLARATION = 'declarations/modules/ladder.json'
const BUS_HISTORY = 'scripts/core/bus-history.ts'
const BUS_HISTORY_SYMBOLS = ['busHistory', 'GhostLine', 'ghostLines', 'ghostLinesText', 'JournalEvent'] as const
const GONE_ROWS = ['boundary:node-launch->cost', 'boundary:cost->node-launch', 'boundary:cost->node-update', 'boundary:node-update->cost'] as const
const ROW_CEILINGS: Readonly<Record<string, number>> = { 'boundary:session->cost': 2, 'boundary:release->cost': 1, 'boundary:decisions->session': 3 }

function textAt(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function declares(source: string, symbol: string): boolean {
  return new RegExp(`^export (?:type|interface|function|const) ${symbol}\\b`, 'm').test(source)
}

it('the ladder module exists, the bus history lives in bus and the cost rows the move empties are gone from contract/ratchet.json', () => {
  const ratchet = JSON.parse(textAt('contract/ratchet.json')) as Record<string, number>
  expect(GONE_ROWS.filter(row => row in ratchet)).toEqual([])
  expect(Object.entries(ROW_CEILINGS).filter(([row, ceiling]) => (ratchet[row] ?? 0) > ceiling)).toEqual([])
  expect(existsSync(path.join(REPO_ROOT, LADDER_DECLARATION))).toBe(true)
  expect((JSON.parse(textAt(LADDER_DECLARATION)) as { module: string }).module).toBe('ladder')
  const source = textAt(BUS_HISTORY)
  expect(BUS_HISTORY_SYMBOLS.filter(symbol => !declares(source, symbol))).toEqual([])
})

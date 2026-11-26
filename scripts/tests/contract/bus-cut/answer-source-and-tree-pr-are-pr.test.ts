import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const RATCHET = 'contract/ratchet.json'
const BOUNDARY = 'boundary:'

const ANSWER_SOURCE = 'scripts/nodes/answer/answer-source.ts'
const TREE_PR = 'scripts/nodes/launch/tree-pr.ts'
const CARD_TREE = 'scripts/ports/card-tree.ts'

const MOVED_MODULES = ['node-answer', 'node-launch', 'pr-record']

const REMOVED_ROWS = [
  'boundary:node-close->node-answer',
  'boundary:node-launch->node-answer',
  'boundary:node-answer->node-launch',
  'boundary:ports->node-answer',
]

const CEILINGS: Readonly<Record<string, number>> = {
  'boundary:board->node-launch': 1,
  'boundary:cost->node-launch': 2,
  'boundary:node-answer->window': 1,
  'boundary:node-launch->cost': 3,
  'boundary:node-launch->node-restart': 1,
  'boundary:node-launch->window': 1,
  'boundary:ports->pr-record': 1,
  'boundary:session->node-launch': 1,
  'boundary:session->pr-record': 1,
  'boundary:window->node-answer': 1,
  'boundary:window->node-launch': 1,
}

const BASE_ROWS_THE_MOVE_LOWERS: Readonly<Record<string, number>> = {
  'boundary:ports->bus': 6,
}

interface Declaration {
  module: string
  paths: string[]
}

function json<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')) as T
}

function endsOf(row: string): string[] {
  return row.slice(BOUNDARY.length).split('->')
}

describe('answer-source and tree-pr belong to pr-record, card-tree to node-answer', () => {
  it('the answer and launch rows the move removes are gone from contract/ratchet.json and none grew', () => {
    const ratchet = json<Record<string, number>>(RATCHET)
    const touched = Object.entries(ratchet).filter(([row]) => row.startsWith(BOUNDARY) && endsOf(row).some(end => MOVED_MODULES.includes(end)))

    for (const row of REMOVED_ROWS)
      expect(ratchet[row], row).toBeUndefined()
    for (const [row, count] of touched)
      expect(count, row).toBeLessThanOrEqual(CEILINGS[row] ?? 0)
    for (const [row, base] of Object.entries(BASE_ROWS_THE_MOVE_LOWERS))
      expect(ratchet[row] ?? 0, row).toBeLessThanOrEqual(base)
  })

  it('the declarations name the moved files under their new owners', () => {
    const prRecord = json<Declaration>('declarations/modules/pr-record.json')
    const nodeAnswer = json<Declaration>('declarations/modules/node-answer.json')

    expect(prRecord.paths).toEqual(expect.arrayContaining([ANSWER_SOURCE, TREE_PR]))
    expect(nodeAnswer.paths).toContain(CARD_TREE)
  })
})

import type { Factory } from '../../contract/factory.js'
import type { Concept } from '../../contract/factory/concepts.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { conceptsSection } from '../../contract/factory.js'
import { assertNoLoreConflict, CONCEPTS, loreConflicts } from '../../contract/factory/concepts.js'

const RECORDED = path.resolve(import.meta.dirname, '../../..', 'contract', 'factory.json')

function concept(id: string, lore: string | null): Concept {
  return { id, title: id, owner: `scripts/${id}.ts`, ownerExists: false, axis: 'interface', lore, detectors: [] }
}

describe('the lore name column of the concepts table', () => {
  it('two concepts holding one lore name are red', () => {
    const table = [concept('agents', 'quickhacks'), concept('commands', 'daemon'), concept('daemon-command', 'daemon')]

    expect(loreConflicts(table)).toEqual({ daemon: ['commands', 'daemon-command'] })
    expect(() => assertNoLoreConflict(table)).toThrow('daemon is held by commands, daemon-command')
    expect(() => conceptsSection({}, table)).toThrow('daemon is held by commands, daemon-command')
  })

  it('two conflicting lore names are reported in alphabetical order, each with its holders, in one message', () => {
    const table = [
      concept('agents', 'quickhacks'),
      concept('commands', 'daemon'),
      concept('board-agents', 'quickhacks'),
      concept('daemon-command', 'daemon'),
    ]

    expect(Object.keys(loreConflicts(table))).toEqual(['daemon', 'quickhacks'])
    expect(loreConflicts(table)).toEqual({ daemon: ['commands', 'daemon-command'], quickhacks: ['agents', 'board-agents'] })
    expect(() => assertNoLoreConflict(table)).toThrow(new Error('one lore name per concept: daemon is held by commands, daemon-command; quickhacks is held by agents, board-agents'))
  })

  it('concepts holding no lore name or distinct ones are not a conflict', () => {
    const table = [concept('agents', 'quickhacks'), concept('commands', 'daemon'), concept('git', null), concept('layers', null)]

    expect(loreConflicts(table)).toEqual({})
    expect(Object.values(conceptsSection({}, table)).map(row => row.lore)).toEqual(['quickhacks', 'daemon', null, null])
  })

  it('the concepts table holds no lore name twice', () => {
    expect(loreConflicts(CONCEPTS)).toEqual({})
  })

  it('every concept recorded in contract/factory.json carries its lore column', () => {
    const { concepts } = JSON.parse(readFileSync(RECORDED, 'utf8')) as Factory

    for (const { id, lore } of CONCEPTS)
      expect(concepts[id], id).toHaveProperty('lore', lore)
  })
})

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../contract/factory/modules.js'
import { buildImportGraph } from '../../contract/module-graph/imports.js'
import { ownerOf, sourceFiles } from '../../contract/module-graph/ownership.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const BUS = 'bus'
const BUS_CONTRACT = 'scripts/ports/bus-contract.ts'
const CARD_RECORD_ON_THE_BUS = ['scripts/core/card-automaton.ts', 'scripts/core/card-bodies.ts']
const FILES = sourceFiles(ROOT)

function importsOf(file: string): string[] {
  return buildImportGraph(ROOT, FILES, [file]).map(edge => edge.to)
}

function ownedByTheBus(file: string): boolean {
  return ownerOf(MODULE_GRAPH, file).includes(BUS)
}

function reachedFrom(seed: string): Set<string> {
  const reached = new Set([seed])
  const frontier = [seed]
  for (let file = frontier.pop(); file !== undefined; file = frontier.pop()) {
    for (const next of importsOf(file).filter(each => !reached.has(each))) {
      reached.add(next)
      frontier.push(next)
    }
  }
  return reached
}

describe('the card record takes the bus as a contract the composition root passes', () => {
  it.each(CARD_RECORD_ON_THE_BUS)('card-automaton and card-bodies import no bus file but the bus contract type: %s', (file) => {
    const imported = importsOf(file)
    expect(imported.filter(ownedByTheBus)).toEqual([])
    expect(imported).toContain(BUS_CONTRACT)
  })

  it('the bus contract type reaches no bus file, so its edge does not count toward gate:bus', () => {
    expect([...reachedFrom(BUS_CONTRACT)].filter(ownedByTheBus)).toEqual([])
  })

  it('the bus contract file is outside the bus module', () => {
    expect(ownedByTheBus(BUS_CONTRACT)).toBe(false)
  })
})

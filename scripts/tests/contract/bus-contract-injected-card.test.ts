import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const MODULE_FILES = 'contract/module-files.json'
const BUS = 'bus'
const PORTS = 'ports'
const BUS_CONTRACT = 'scripts/core/bus-contract.ts'
const CARD_RECORD_ON_THE_BUS = ['scripts/core/card-automaton.ts', 'scripts/core/card-bodies.ts']
const OWNED = JSON.parse(readFileSync(path.join(ROOT, MODULE_FILES), 'utf8')) as Record<string, string[]>
const BUS_FILES = new Set(OWNED[BUS])

function relativeImportsOf(file: string): string[] {
  const { importedFiles } = ts.preProcessFile(readFileSync(path.join(ROOT, file), 'utf8'), true, true)
  return importedFiles
    .map(imported => imported.fileName)
    .filter(specifier => specifier.startsWith('.'))
    .map(specifier => path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/, '.ts'))
    .filter(target => existsSync(path.join(ROOT, target)))
}

function reachedFrom(seed: string): Set<string> {
  const reached = new Set([seed])
  const frontier = [seed]
  for (let file = frontier.pop(); file !== undefined; file = frontier.pop()) {
    for (const next of relativeImportsOf(file).filter(each => !reached.has(each))) {
      reached.add(next)
      frontier.push(next)
    }
  }
  return reached
}

describe('the card record takes the bus as a contract the composition root passes', () => {
  it.each(CARD_RECORD_ON_THE_BUS)('card-automaton and card-bodies import no bus file but the bus contract type: %s', (file) => {
    const imported = relativeImportsOf(file)
    expect(imported.filter(each => BUS_FILES.has(each))).toEqual([])
    expect(imported).toContain(BUS_CONTRACT)
  })

  it('the bus contract type reaches no bus file, so its edge does not count toward gate:bus', () => {
    expect([...reachedFrom(BUS_CONTRACT)].filter(each => BUS_FILES.has(each))).toEqual([])
  })

  it('the bus contract file is owned by ports, outside the bus module', () => {
    expect(BUS_FILES.has(BUS_CONTRACT)).toBe(false)
    expect(OWNED[PORTS]).toContain(BUS_CONTRACT)
  })
})

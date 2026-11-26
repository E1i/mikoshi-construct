import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as shapes from '../../../ports/identifier-shapes.js'

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const IDENTIFIERS = 'scripts/core/identifiers.ts'
const SHAPES = 'scripts/ports/identifier-shapes.ts'
const PORTS_IMPORTERS = ['scripts/ports/snapshot.ts', 'scripts/ports/main-merge.ts']
const IDENTIFIERS_SPECIFIER = '../core/identifiers.js'
const BUS_TO_CARD_MODEL = 'boundary:bus->card-model'
const PORTS_TO_CARD_MODEL = 'boundary:ports->card-model'
const PORTS_TO_CARD_MODEL_BEFORE = 4
const SHA256_OF_BODY = '230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5'

interface DrawnModules {
  modules: { modules: Record<string, { contract: readonly string[] }> }
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as T
}

function holdersOf(file: string): string[] {
  return Object.entries(readJson<Record<string, readonly string[]>>('contract/module-files.json')).filter(([, files]) => files.includes(file)).map(([module]) => module)
}

describe('the identifiers sit under the bus and their shapes in ports', () => {
  it('core/identifiers.ts is owned by and contracted to bus, identifier-shapes.ts to ports', () => {
    const drawn = readJson<DrawnModules>('contract/factory.json').modules.modules
    expect(holdersOf(IDENTIFIERS)).toEqual(['bus'])
    expect(holdersOf(SHAPES)).toEqual(['ports'])
    expect(drawn.bus!.contract).toContain(IDENTIFIERS)
    expect(drawn.ports!.contract).toContain(SHAPES)
  })

  it('the ratchet holds no bus->card-model row and a lower ports->card-model row', () => {
    const ratchet = readJson<Record<string, number>>('contract/ratchet.json')
    expect(ratchet[BUS_TO_CARD_MODEL]).toBeUndefined()
    expect(ratchet[PORTS_TO_CARD_MODEL] ?? 0).toBeLessThan(PORTS_TO_CARD_MODEL_BEFORE)
  })

  it('no ports importer reads core/identifiers.ts', () => {
    expect(PORTS_IMPORTERS.filter(file => readFileSync(path.join(ROOT, file), 'utf8').includes(IDENTIFIERS_SPECIFIER))).toEqual([])
  })

  it('the shapes read a card id and a pull request body the way the bus keys them', () => {
    expect(shapes.cardIdOfDescription('card: #2313 w3-identifiers-under-bus\nbody')).toBe(2313)
    expect(shapes.cardIdOf({ id: '#7 x' })).toBe(7)
    expect(shapes.positiveInteger(0)).toBeNull()
    expect(shapes.prBodySha('body')).toBe(SHA256_OF_BODY)
    expect(shapes.isFullSha(shapes.prBodySha('body').slice(0, 40))).toBe(true)
    expect(shapes.MAIN_BRANCH).toBe('main')
  })
})

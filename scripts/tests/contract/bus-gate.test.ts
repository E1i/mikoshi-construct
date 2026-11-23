import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gateNumbers, ratchetBreaks, readRatchet } from '../../contract/ratchet.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const GATE_KEY = 'gate:bus'
const BUS_FILE = 'scripts/core/db.ts'
const MEASURE_TIMEOUT = 180_000
const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function treeOf(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-gate-'))
  roots.push(root)
  for (const [file, text] of Object.entries({ [BUS_FILE]: 'export const openBus = 1\n', ...files })) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

const FIXTURE_TREE = {
  'scripts/tests/fixture.ts': 'export { openBus } from \'../core/db.js\'\n',
  'scripts/tests/direct.test.ts': 'import { openBus } from \'../core/db.js\'\nexport const a = openBus\n',
  'tests/through-fixture.test.ts': 'import { openBus } from \'../scripts/tests/fixture.js\'\nexport const b = openBus\n',
  'tests/free.test.ts': 'export const c = 1\n',
  'src/unrelated.ts': 'export const d = 1\n',
}

describe('the bus gate', () => {
  it('counts every test file with an import path to a bus file, directly or through a fixture, and no other', () => {
    expect(gateNumbers(treeOf(FIXTURE_TREE))).toEqual({ [GATE_KEY]: 2 })
  })

  it('a new test that reaches bus grows the row and is red; a test that leaves it is red until the row is lowered', () => {
    const recorded = gateNumbers(treeOf(FIXTURE_TREE))
    const grown = gateNumbers(treeOf({ ...FIXTURE_TREE, 'tests/free.test.ts': 'import { openBus } from \'../scripts/core/db.js\'\nexport const c = openBus\n' }))
    const fallen = gateNumbers(treeOf({ ...FIXTURE_TREE, 'scripts/tests/direct.test.ts': 'export const a = 1\n' }))
    expect(ratchetBreaks(recorded, grown)).toEqual([expect.stringContaining(`${GATE_KEY} grew from 2 to 3`)])
    expect(ratchetBreaks(recorded, fallen)).toEqual([expect.stringContaining(`${GATE_KEY} went down from 2 to 1`)])
    expect(ratchetBreaks(fallen, fallen)).toEqual([])
  })

  it('the bus gate is a ratchet row and does not grow', { timeout: MEASURE_TIMEOUT }, () => {
    const recorded = readRatchet(ROOT)
    expect(recorded[GATE_KEY]).toBeGreaterThan(0)
    expect(ratchetBreaks({ [GATE_KEY]: recorded[GATE_KEY]! }, gateNumbers(ROOT))).toEqual([])
  })
})

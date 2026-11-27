import type { GrownDerived, WitnessGrowthFacts } from '../../policy/derived-files.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allowedEntry, derivedGrowthLine, GATE_BUS_ROW, unallowedGrowth, witnessGrowthAllowances, witnessTestFilesOf } from '../../policy/derived-files.js'

const RATCHET = 'contract/ratchet.json'
const KNOWN = '.dependency-cruiser-known-violations.json'
const NEW_WITNESS = 'scripts/tests/bus/a-new-witness.test.ts'
const OLD_WITNESS = 'scripts/tests/bus/an-old-witness.test.ts'
const UNNAMED_NEW_TEST = 'scripts/tests/bus/not-a-witness.test.ts'
const RUN_OF = (file: string): string => `pnpm exec vitest run ${file} -t 'the witness'`

function facts(overrides: Partial<WitnessGrowthFacts> = {}): WitnessGrowthFacts {
  return { underAShard: true, witnessRuns: [RUN_OF(NEW_WITNESS)], added: file => file === NEW_WITNESS || file === UNNAMED_NEW_TEST, ...overrides }
}

function ratchetGrowth(...entries: string[]): GrownDerived[] {
  return [{ file: RATCHET, entries }]
}

describe('gate:bus grows by one per new witness file under a shard (D-883)', () => {
  it('gate:bus +1 for one new witness file merges with no owner wait', () => {
    const allowances = witnessGrowthAllowances(facts())
    expect(allowances).toHaveLength(1)
    expect(allowances[0]).toContain(NEW_WITNESS)
    expect(unallowedGrowth(ratchetGrowth(`${GATE_BUS_ROW} (659 → 660)`), allowances)).toEqual([])
    expect(allowedEntry(`${GATE_BUS_ROW} (659 → 660)`, allowances)).toBe(true)
    const two = witnessGrowthAllowances(facts({ witnessRuns: [RUN_OF(NEW_WITNESS), `pnpm exec vitest run ${UNNAMED_NEW_TEST} ${NEW_WITNESS}`] }))
    expect(unallowedGrowth(ratchetGrowth(`${GATE_BUS_ROW} (659 → 661)`), two)).toEqual([])
  })

  it('gate:bus +2 for one new witness file still opens the owner wait', () => {
    const allowances = witnessGrowthAllowances(facts())
    const beyond = ratchetGrowth(`${GATE_BUS_ROW} (659 → 661)`)
    expect(unallowedGrowth(beyond, allowances)).toEqual(beyond)
    expect(derivedGrowthLine(unallowedGrowth(beyond, allowances))).toContain('D-592')
    for (const row of ['boundary:node-answer->bus (3 → 4)', 'overlaps:bus-read (12 → 13)', 'lines:scripts/policy/policy.ts (801 → 802)', `${GATE_BUS_ROW} (new: 1)`, 'gate:bus-other (5 → 6)'])
      expect(unallowedGrowth(ratchetGrowth(row), allowances), row).toEqual(ratchetGrowth(row))
    const known = [{ file: KNOWN, entries: ['{"from":"a.ts","to":"b.ts"}'] }]
    expect(unallowedGrowth(known, allowances)).toEqual(known)
  })

  it('without a shard, or without a new file a witness run names, gate:bus growth stays the owner\'s', () => {
    const growth = ratchetGrowth(`${GATE_BUS_ROW} (659 → 660)`)
    for (const without of [{ underAShard: false }, { witnessRuns: [RUN_OF(OLD_WITNESS)] }, { witnessRuns: [] }, { added: () => false }]) {
      expect(witnessGrowthAllowances(facts(without)), JSON.stringify(without)).toEqual([])
      expect(unallowedGrowth(growth, witnessGrowthAllowances(facts(without)))).toEqual(growth)
    }
  })

  it('a witness run names its test files by path, once each', () => {
    expect(witnessTestFilesOf([`pnpm exec vitest run ${NEW_WITNESS} ${NEW_WITNESS}`, 'pnpm typecheck', `! ( pnpm exec vitest run tests/a.test.mts\n)`])).toEqual([NEW_WITNESS, 'tests/a.test.mts'])
  })

  it('the witness test reaches no bus file, so it does not grow gate:bus itself', () => {
    const imports = [...readFileSync(new URL(import.meta.url), 'utf8').matchAll(/^import .* from '([^']+)'$/gm)].map(match => match[1])
    expect(imports.filter(source => source!.startsWith('.'))).toEqual(['../../policy/derived-files.js', '../../policy/derived-files.js'])
    expect(readFileSync(new URL('../../policy/derived-files.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m)
  })
})

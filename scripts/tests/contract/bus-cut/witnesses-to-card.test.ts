import { describe, expect, it } from 'vitest'
import * as witnessFields from '../../../../src/card/witness-fields.js'
import * as admit from '../../../../src/commands/intake/admit.js'
import { repositoryReport } from '../../../contract/module-graph/report.js'

const REPO_RUN_TIMEOUT = 180_000

const ADMIT = 'src/commands/intake/admit.ts'
const WITNESS_FIELDS = 'src/card/witness-fields.ts'
const POLICY = 'scripts/policy/policy.ts'
const READERS_OF_THE_WITNESSES = [
  'scripts/intake/card-contract.ts',
  'scripts/intake/witness-fields-backfill.ts',
  POLICY,
  'scripts/policy/round-limit-decision.ts',
  'scripts/supervisor/composition.ts',
]
const VIOLATING_IMPORTS_AT_MOST = 1079

describe('the reading of a card\'s witnesses lives in src/card/witness-fields.ts', () => {
  it('witness-fields exports witnessesOf and judgedFieldWitnessesOf, and admit exports neither', () => {
    expect(Object.keys(witnessFields)).toEqual(expect.arrayContaining(['witnessesOf', 'judgedFieldWitnessesOf']))
    expect(Object.keys(admit)).not.toContain('witnessesOf')
    expect(Object.keys(admit)).not.toContain('judgedFieldWitnessesOf')
    expect(witnessFields.witnessesOf('Witnesses:\n- `pnpm test` exits 0\n\nafter')).toEqual(['`pnpm test` exits 0'])
  })

  it('policy imports admit no more, every reader takes the witnesses from witness-fields, and the violating imports do not grow', { timeout: REPO_RUN_TIMEOUT }, () => {
    const report = repositoryReport()
    const imports = report.graph.imports

    expect(imports.filter(({ from, to }) => from === POLICY && to === ADMIT)).toEqual([])
    for (const reader of READERS_OF_THE_WITNESSES)
      expect(imports.some(({ from, to }) => from === reader && to === WITNESS_FIELDS), reader).toBe(true)
    expect(report.statistics.violatingImports).toBeLessThanOrEqual(VIOLATING_IMPORTS_AT_MOST)
  })
})

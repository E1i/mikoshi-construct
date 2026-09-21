import { describe, expect, it } from 'vitest'
import { sampleWasMaterialized } from '../src/materialize/sample.js'

const POLICY_TEST = 'scripts/tests/lint/syntax-policy.test.ts'
const MANIFEST = 'package.json'

describe('whether the construct materialized the preset sample into this repository', () => {
  it('reads it from a recorded path only the sample groups produce', () => {
    expect(sampleWasMaterialized([POLICY_TEST, MANIFEST], [MANIFEST], { [POLICY_TEST]: 'sha', [MANIFEST]: 'sha' })).toBe(true)
  })

  it('says no where the record carries nothing the sample alone would have written', () => {
    expect(sampleWasMaterialized([POLICY_TEST, MANIFEST], [MANIFEST], { [MANIFEST]: 'sha' })).toBe(false)
  })

  it('does not read a path the groups without the sample produce as evidence of the sample, however the record came by it', () => {
    expect(sampleWasMaterialized([MANIFEST], [MANIFEST], { [MANIFEST]: 'sha' })).toBe(false)
  })

  it('says no where the preset has no sample to look for', () => {
    expect(sampleWasMaterialized([], [MANIFEST], { [MANIFEST]: 'sha' })).toBe(false)
  })
})

import type { TemplateVars } from '../src/presets/index.js'
import { describe, expect, it } from 'vitest'
import { LEVELS } from '../src/commands/doctor/verdict.js'
import { ENFORCEMENT_LEVELS } from '../src/model/schema.js'
import { buildModel } from '../src/model/write.js'

const VARS: TemplateVars = {
  projectName: 'scope-fixture',
  scope: '@scope-fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: '',
  contractTypesOutput: '',
  compositionDir: 'architecture/composition',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: 'claude-sonnet-5',
  constructVersion: '0.1.0',
}

describe('an identifier others cite carries one scope, and only one', () => {
  it('reads the enforcement levels from one list rather than two kept in step, so there is no second copy to widen', () => {
    expect(LEVELS).toBe(ENFORCEMENT_LEVELS)
  })

  it('gives every check id exactly one home, so no id can come to mean two things', () => {
    const claims = buildModel({ vars: VARS, contracts: true, sample: true }).claims
    const checkIds = claims.flatMap(claim => claim.checkId ?? [])
    expect(checkIds.length).toBeGreaterThan(0)
    expect(new Set(checkIds).size).toBe(checkIds.length)
    expect(checkIds.filter(id => claims.some(claim => claim.id === id && claim.checkId !== id))).toEqual([])
  })
})

import type { TemplateVars } from '../src/presets/index.js'
import { describe, expect, it } from 'vitest'
import { buildModel } from '../src/model/write.js'

const FOREIGN_HARNESS = 'make check'
const DEFAULT_HARNESS = 'pnpm run quality'

const VARS: TemplateVars = {
  projectName: 'pinned-fixture',
  scope: '@pinned-fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: '',
  contractTypesOutput: '',
  compositionDir: 'architecture/composition',
  harnessCommand: FOREIGN_HARNESS,
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: 'claude-sonnet-5',
  constructVersion: '0.1.0',
}

describe('a claim naming a foreign harness names only what it can know', () => {
  it('states that the foreign command passes on every change, with no verification', () => {
    const model = buildModel({ vars: VARS, contracts: false, sample: false })
    const claim = model.claims.find(claim => claim.id === 'every-change-passes-the-harness')

    expect(claim?.statement).toBe(`${FOREIGN_HARNESS} passes on every change`)
    expect(claim?.verification).toBeNull()
  })

  it('states that the quality script passes lint, typecheck and tests, with the eslint verification, by default', () => {
    const model = buildModel({ vars: { ...VARS, harnessCommand: DEFAULT_HARNESS }, contracts: false, sample: false })
    const claim = model.claims.find(claim => claim.id === 'every-change-passes-the-harness')

    expect(claim?.statement).toBe('Lint, typecheck and tests pass on every change, as one command')
    expect(claim?.verification?.supportedBy).toEqual(['eslint-config'])
  })

  it('is not born with a foreign harness', () => {
    const model = buildModel({ vars: VARS, contracts: false, sample: true })

    expect(model.claims.map(claim => claim.id)).not.toContain('lint-policy')
  })

  it('is born by default', () => {
    const model = buildModel({ vars: { ...VARS, harnessCommand: DEFAULT_HARNESS }, contracts: false, sample: true })

    expect(model.claims.map(claim => claim.id)).toContain('lint-policy')
  })
})

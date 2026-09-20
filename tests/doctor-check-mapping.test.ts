import type { TemplateVars } from '../src/presets/index.js'
import { describe, expect, it } from 'vitest'
import { CHECK_IDS } from '../src/commands/doctor/verdict.js'
import { buildModel } from '../src/model/write.js'

type Decision
  = | { outcome: 'maps-onto-an-existing-claim', claimId: string }
    | { outcome: 'its-own-claim', claimId: string, onlyWhen: 'sample' }
    | { outcome: 'provenance', because: string }
    | { outcome: 'dropped', because: string }

const DECIDED: Record<string, Decision> = {
  'ci': {
    outcome: 'maps-onto-an-existing-claim',
    claimId: 'every-change-passes-the-harness',
  },
  'lint-policy': {
    outcome: 'its-own-claim',
    claimId: 'lint-policy',
    onlyWhen: 'sample',
  },
  'construct-tests': {
    outcome: 'provenance',
    because: 'it asks whether the files construct.json records are still collected by the runner config init also wrote, which becomes false only when what init installed changed',
  },
  'hook': {
    outcome: 'dropped',
    because: 'no preset materializes a hook, and the construct makes no claim about one',
  },
  'red-gate': {
    outcome: 'dropped',
    because: 'it states doctor\'s own limit rather than a fact about the repository',
  },
}

function undecided(ids: readonly string[]): string[] {
  return ids.filter(id => DECIDED[id] == null)
}

function undecidedMessage(ids: readonly string[]): string {
  return `no recorded decision about where the verdict of ${undecided(ids).join(', ')} belongs: add it to DECIDED as a claim, as provenance, or as dropped with a reason`
}

const VARS: TemplateVars = {
  projectName: 'mapping-fixture',
  scope: '@mapping-fixture',
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

const withSample = buildModel({ vars: VARS, contracts: false, sample: true }).claims.map(claim => claim.id)
const withoutSample = buildModel({ vars: VARS, contracts: false, sample: false }).claims.map(claim => claim.id)

describe('every doctor check has a recorded decision about where its verdict belongs', () => {
  it('leaves no check id undecided, and names the ones it would', () => {
    expect(undecided(CHECK_IDS), undecidedMessage(CHECK_IDS)).toEqual([])
    expect(undecided([...CHECK_IDS, 'sbom'])).toEqual(['sbom'])
    expect(undecidedMessage([...CHECK_IDS, 'sbom'])).toContain('sbom')
  })

  for (const id of CHECK_IDS) {
    it(`${id}: resolves to exactly one outcome, and the model agrees with it`, () => {
      const decision = DECIDED[id]
      expect(decision, undecidedMessage([id])).toBeDefined()
      if (decision.outcome === 'maps-onto-an-existing-claim') {
        expect(withoutSample).toContain(decision.claimId)
        expect(withSample).not.toContain(id)
      }
      if (decision.outcome === 'its-own-claim') {
        expect(withSample).toContain(decision.claimId)
        expect(withoutSample).not.toContain(decision.claimId)
      }
      if (decision.outcome === 'provenance' || decision.outcome === 'dropped') {
        expect(decision.because.length).toBeGreaterThan(0)
        expect(withSample).not.toContain(id)
      }
    })
  }
})

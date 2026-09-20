import type { CheckState, CheckVerdict, Level } from '../src/commands/doctor/index.js'
import type { FileOp } from '../src/materialize/plan.js'
import type { SelectedPath } from '../src/model/path.js'
import type { Claim } from '../src/model/schema.js'
import type { TemplateVars } from '../src/presets/index.js'
import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/commands/doctor/index.js'
import { RUNNER_CONFIG_FILES } from '../src/commands/doctor/runner.js'
import { buildManifest, writeManifest } from '../src/manifest.js'
import { buildModel, writeModel } from '../src/model/write.js'

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures/doctor')
const CONTROL = 'healthy'

interface CheckExpectation {
  id: string
  state: CheckState
  level: Level
  mechanism: string
}

interface FixtureExpectation {
  lie: string
  ok: boolean
  checks: CheckExpectation[]
  uncollectedTests?: string[]
  youAreHere?: SelectedPath | null
}

const FIXTURES: Record<string, FixtureExpectation> = {
  'broken-eslint-config': {
    lie: 'reports the lint-policy claim as unsupported on a repository carrying no test that resolves the policy',
    ok: true,
    checks: [{ id: 'lint-policy', state: 'unsupported', level: 'L3', mechanism: 'scripts/tests/lint/syntax-policy.test.ts' }],
  },
  'orphaned-construct-tests': {
    lie: 'names the recorded test the runner config it also recorded never collects',
    ok: true,
    checks: [],
    uncollectedTests: ['tests/harness.test.ts'],
  },
  'quality-not-in-ci': {
    lie: 'reports the harness claim as unsupported where no workflow step runs the harness command',
    ok: true,
    checks: [{ id: 'ci', state: 'unsupported', level: 'L3', mechanism: '.github/workflows/ci.yml' }],
  },
  'healthy': {
    lie: 'reports a construct whose every claim is held on the control, where the facts under them all hold',
    ok: true,
    checks: [
      { id: 'lint-policy', state: 'held', level: 'L3', mechanism: 'scripts/tests/lint/syntax-policy.test.ts' },
      { id: 'ci', state: 'held', level: 'L3', mechanism: '.github/workflows/ci.yml' },
    ],
    uncollectedTests: [],
    youAreHere: null,
  },
}

const VARS: TemplateVars = {
  projectName: 'fixture',
  scope: '@fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: 'contracts/api/openapi.yaml',
  contractTypesOutput: 'src/contracts/openapi.ts',
  compositionDir: 'architecture/composition',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: '',
  constructVersion: '0.0.0-fixture',
}

interface FixtureOptions {
  model?: boolean
  recordRunnerConfig?: boolean
}

function fileOps(root: string, directory = ''): FileOp[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const target = directory === '' ? entry.name : `${directory}/${entry.name}`
    if (entry.isDirectory())
      return fileOps(root, target)
    return [{ target, strategy: 'create', action: 'create', content: readFileSync(path.join(root, target), 'utf8') } satisfies FileOp]
  })
}

function materializeFixture(name: string, options: FixtureOptions = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), `construct-doctor-${name}-`))
  cpSync(path.join(FIXTURES_DIR, name), root, { recursive: true })
  const written = fileOps(root).filter(op => options.recordRunnerConfig === false ? !RUNNER_CONFIG_FILES.includes(op.target) : true)
  const manifest = buildManifest({
    version: VARS.constructVersion,
    preset: 'node-backend',
    ai: 'claude',
    review: 'none',
    vars: VARS,
    written,
    contracts: false,
    previous: null,
  })
  writeManifest(root, manifest)
  if (options.model !== false)
    writeModel(root, buildModel({ vars: VARS, contracts: false, sample: true }))
  return root
}

function modelClaims(): Claim[] {
  return buildModel({ vars: VARS, contracts: false, sample: true }).claims
}

function claimNamed(id: string): Claim | undefined {
  return modelClaims().find(claim => claim.id === id)
}

function fixtureDirectories(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

function verdictFor(checks: CheckVerdict[], id: string): CheckVerdict {
  const verdict = checks.find(check => check.id === id)
  if (verdict == null)
    throw new Error(`doctor reported no verdict for "${id}"`)
  return verdict
}

describe('doctor on the fixtures', () => {
  for (const [name, expectation] of Object.entries(FIXTURES)) {
    it(`${name}: ${expectation.lie}`, () => {
      const result = runDoctor(materializeFixture(name))
      expect(result?.ok).toBe(expectation.ok)
      expect(result?.checks.map(check => check.claimId)).toEqual(modelClaims().map(claim => claim.id))
      for (const expected of expectation.checks) {
        const verdict = verdictFor(result?.checks ?? [], expected.id)
        expect({ id: verdict.id, state: verdict.state, level: verdict.level }).toEqual({ id: expected.id, state: expected.state, level: expected.level })
        expect(verdict.mechanism).toContain(expected.mechanism)
      }
      if (expectation.uncollectedTests != null)
        expect(result?.uncollectedTests).toEqual(expectation.uncollectedTests)
      if (expectation.youAreHere !== undefined)
        expect(result?.youAreHere).toEqual(expectation.youAreHere)
    })
  }

  it('never claims L4, and renders every verdict from a claim the model carries', () => {
    for (const name of Object.keys(FIXTURES)) {
      const checks = runDoctor(materializeFixture(name))?.checks ?? []
      expect(checks.map(check => check.level)).not.toContain('L4')
      for (const check of checks) {
        expect(claimNamed(check.claimId)?.checkId ?? check.claimId).toBe(check.id)
        expect(check.authoredBy).toBe('construct')
        expect(check.mechanism).not.toBe('')
      }
    }
  })

  it('completes with no verdict at all on a repository carrying no construct.model.json', () => {
    const result = runDoctor(materializeFixture(CONTROL, { model: false }))
    expect(result?.checks).toEqual([])
    expect(result?.youAreHere).toBeNull()
    expect(result?.ok).toBe(true)
  })

  it('says nothing about uncollected tests where the construct never wrote the runner config', () => {
    expect(runDoctor(materializeFixture('orphaned-construct-tests', { recordRunnerConfig: false }))?.uncollectedTests).toEqual([])
  })

  it('has one fixture directory per property doctor reports on, and one fixture per check id', () => {
    expect(fixtureDirectories().sort()).toEqual(Object.keys(FIXTURES).sort())
    const provoked = Object.entries(FIXTURES)
      .filter(([name]) => name !== CONTROL)
      .flatMap(([, expectation]) => expectation.checks.map(check => check.id))
    for (const id of modelClaims().flatMap(claim => claim.checkId ?? []))
      expect(provoked).toContain(id)
  })
})

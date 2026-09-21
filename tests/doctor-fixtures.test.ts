import type { CheckState, CheckVerdict, ClaimPlacement, DoctorResult, Level } from '../src/commands/doctor/index.js'
import type { FileOp } from '../src/materialize/plan.js'
import type { Claim } from '../src/model/schema.js'
import type { TemplateVars } from '../src/presets/index.js'
import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { printDoctor, runDoctor } from '../src/commands/doctor/index.js'
import { RUNNER_CONFIG_FILES } from '../src/commands/doctor/runner.js'
import { buildManifest, writeManifest } from '../src/manifest.js'
import { MODEL_VERSION } from '../src/model/schema.js'
import { buildModel, writeModel } from '../src/model/write.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures/doctor')
const CONTROL = 'healthy'

interface CheckExpectation {
  id: string
  state: CheckState
  level: Level
  mechanism: string
  doesNotHold?: string[]
}

interface FixtureExpectation {
  lie: string
  ok: boolean
  checks: CheckExpectation[]
  unreadableFiles?: string[]
  uncollectedTests?: string[]
  harnessProblems?: string[]
  youAreHere?: ClaimPlacement
  youAreHereLine?: string
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
  'unreadable-recorded-file': {
    lie: 'names a recorded file a directory now stands in the place of as unreadable, rather than crashing on it or calling it missing',
    ok: false,
    checks: [],
    unreadableFiles: ['tests/harness.test.ts'],
  },
  'quality-not-in-ci': {
    lie: 'reports the harness claim as unsupported where no workflow step runs the harness command',
    ok: true,
    checks: [{ id: 'ci', state: 'unsupported', level: 'L3', mechanism: '.github/workflows/ci.yml' }],
  },
  'harness-skips-lint': {
    lie: 'reports a harness command that dropped lint as an unsupported claim, and not as a problem with the construct',
    ok: true,
    checks: [{ id: 'harness-steps', state: 'unsupported', level: 'L3', mechanism: 'package.json spells that command out', doesNotHold: ['package.json'] }],
    harnessProblems: [],
    youAreHere: { at: 'stop', stop: { claimId: 'harness-steps', stage: 'enforcement', state: 'unsupported', doesNotHold: ['package.json'] } },
    youAreHereLine: 'You are here: harness-steps \u2014 enforcement unsupported: package.json no longer matches',
  },
  'healthy': {
    lie: 'reports a construct whose every claim is held on the control, where the facts under them all hold',
    ok: true,
    checks: [
      { id: 'lint-policy', state: 'held', level: 'L3', mechanism: 'scripts/tests/lint/syntax-policy.test.ts' },
      { id: 'ci', state: 'held', level: 'L3', mechanism: '.github/workflows/ci.yml' },
      { id: 'harness-steps', state: 'held', level: 'L3', mechanism: 'package.json spells that command out' },
    ],
    uncollectedTests: [],
    harnessProblems: [],
    youAreHere: { at: 'no-stop' },
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

type ModelCarried = 'built' | 'no-claim' | 'absent'

interface FixtureOptions {
  model?: ModelCarried
  recordRunnerConfig?: boolean
}

function standsWhereAFileIsExpected(root: string, directory: string): boolean {
  return readdirSync(path.join(root, directory)).join() === '.gitkeep'
}

function fileOps(root: string, directory = ''): FileOp[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const target = directory === '' ? entry.name : `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      if (standsWhereAFileIsExpected(root, target))
        return [{ target, strategy: 'create', action: 'create', content: '' } satisfies FileOp]
      return fileOps(root, target)
    }
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
    policy: null,
  })
  writeManifest(root, manifest)
  const carried = options.model ?? 'built'
  if (carried === 'built')
    writeModel(root, buildModel({ vars: VARS, contracts: false, sample: true }))
  if (carried === 'no-claim')
    writeModel(root, { modelVersion: MODEL_VERSION, facts: [], claims: [], hypotheses: [] })
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

function unreadablePath(entry: string): string {
  return entry.slice(0, entry.indexOf(' ('))
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
        if (expected.doesNotHold != null)
          expect(verdict).toMatchObject({ doesNotHold: expected.doesNotHold })
      }
      if (expectation.harnessProblems != null)
        expect(result?.harnessProblems).toEqual(expectation.harnessProblems)
      if (expectation.unreadableFiles != null) {
        expect(result?.unreadableFiles.map(unreadablePath)).toEqual(expectation.unreadableFiles)
        for (const file of expectation.unreadableFiles) {
          expect(result?.missingFiles).not.toContain(file)
          expect(result?.modifiedFiles).not.toContain(file)
        }
      }
      if (expectation.uncollectedTests != null)
        expect(result?.uncollectedTests).toEqual(expectation.uncollectedTests)
      if (expectation.youAreHere !== undefined)
        expect(result?.youAreHere).toEqual(expectation.youAreHere)
      if (expectation.youAreHereLine !== undefined)
        expect(lastLine(rendered(result as DoctorResult).output)).toBe(expectation.youAreHereLine)
    })
  }

  it('carries the cause beside the file it could not read, so a second cause needs no second reading', () => {
    const result = runDoctor(materializeFixture('unreadable-recorded-file'))
    expect(result?.unreadableFiles).toHaveLength(1)
    expect(result?.unreadableFiles[0]).toMatch(/^tests\/harness\.test\.ts \(.+\)$/)
  })

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

  it('renders a harness that stopped running lint as a claim rather than a problem, so it lands where the control does rather than failing the run', () => {
    const skipping = runDoctor(materializeFixture('harness-skips-lint'))
    const control = runDoctor(materializeFixture(CONTROL))
    expect(skipping?.harnessProblems).toEqual([])
    expect(skipping?.ok).toBe(control?.ok)
    expect(verdictFor(skipping?.checks ?? [], 'harness-steps').state).toBe('unsupported')
    expect(verdictFor(control?.checks ?? [], 'harness-steps').state).toBe('held')
  })

  it('completes with no verdict at all on a repository carrying no construct.model.json', () => {
    const result = runDoctor(materializeFixture(CONTROL, { model: 'absent' }))
    expect(result?.checks).toEqual([])
    expect(result?.youAreHere).toEqual({ at: 'no-model' })
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

interface PlacementExpectation {
  model: ModelCarried
  placement: ClaimPlacement
  line: string
  says: string[]
}

const CLAIMS_CARRIED: Record<string, PlacementExpectation> = {
  'no model at all': {
    model: 'absent',
    placement: { at: 'no-model' },
    line: 'nowhere to place you',
    says: ['there is no construct.model.json', 'nothing is known about what this repository claims', 'not a reading that nothing is enforced'],
  },
  'a model carrying no claim': {
    model: 'no-claim',
    placement: { at: 'no-claim' },
    line: 'construct.model.json carries no claim, so there is none to place',
    says: ['construct.model.json names no claim', 'it asserts nothing about this repository'],
  },
  'a model whose every chain holds': {
    model: 'built',
    placement: { at: 'no-stop' },
    line: 'no claim stops before the end of its chain',
    says: ['no-committed-secret'],
  },
}

function rendered(result: DoctorResult): { output: string, code: number } {
  const lines: string[] = []
  const ui = createUi(resolveTheme({ plain: true, johnny: false }), text => lines.push(text))
  const code = printDoctor(ui, result)
  return { output: lines.join(''), code }
}

function lastLine(output: string): string {
  return output.split('\n').filter(line => line.trim() !== '').at(-1) ?? ''
}

describe('what doctor says about claims, where the repository carries none to say it of', () => {
  for (const [situation, expectation] of Object.entries(CLAIMS_CARRIED)) {
    it(`reads ${situation} as itself, in the line it prints and not only in the JSON`, () => {
      const result = runDoctor(materializeFixture(CONTROL, { model: expectation.model })) as DoctorResult
      const { output, code } = rendered(result)

      expect(result.youAreHere).toEqual(expectation.placement)
      expect(result.ok).toBe(true)
      expect(code).toBe(0)
      expect(result.checks.map(check => check.state as string)).not.toContain('absent')
      expect(lastLine(output)).toContain(expectation.line)
      for (const said of expectation.says)
        expect(output).toContain(said)
    })
  }

  it('renders a different line for each of the three, so no one of them reads as another', () => {
    const lines = Object.values(CLAIMS_CARRIED)
      .map(expectation => lastLine(rendered(runDoctor(materializeFixture(CONTROL, { model: expectation.model })) as DoctorResult).output))
    expect(new Set(lines).size).toBe(Object.keys(CLAIMS_CARRIED).length)
  })
})

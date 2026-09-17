import type { CheckId, CheckState, CheckVerdict, Level } from '../src/commands/doctor/index.js'
import type { FileOp } from '../src/materialize/plan.js'
import type { TemplateVars } from '../src/presets/index.js'
import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECK_IDS, runDoctor } from '../src/commands/doctor/index.js'
import { buildManifest, writeManifest } from '../src/manifest.js'

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures/doctor')
const CONTROL = 'healthy'

interface CheckExpectation {
  id: CheckId
  state: CheckState
  level: Level
  evidence?: string
}

interface FixtureExpectation {
  lie: string
  ok: boolean
  checks: CheckExpectation[]
  weakestLink?: { id: CheckId, level: Level } | null
}

const FIXTURES: Record<string, FixtureExpectation> = {
  'broken-eslint-config': {
    lie: 'names the lint policy as unenforced on a repository whose eslint config is never resolved by any test',
    ok: true,
    checks: [{ id: 'lint-policy', state: 'absent', level: 'L0', evidence: 'runs ESLint over the lint policy this repository declares' }],
  },
  'orphaned-construct-tests': {
    lie: 'names the construct tests as uncollected on a repository whose tests fall outside the vitest include globs',
    ok: true,
    checks: [{ id: 'construct-tests', state: 'absent', level: 'L0', evidence: 'tests/harness.test.ts' }],
  },
  'red-gate': {
    lie: 'reports the red gate as unknown, because proving a clean checkout is green means running it',
    ok: true,
    checks: [{ id: 'red-gate', state: 'unknown', level: 'L0', evidence: 'doctor executes nothing' }],
  },
  'quality-not-in-ci': {
    lie: 'reports CI as unknown where no workflow ever runs the harness command',
    ok: true,
    checks: [{ id: 'ci', state: 'unknown', level: 'L0', evidence: '.github/workflows/ci.yml' }],
  },
  'script-without-hook': {
    lie: 'reports a command claimed as a guard at L0, with no hook manager and no core.hooksPath to install it',
    ok: true,
    checks: [{ id: 'hook', state: 'present', level: 'L0', evidence: 'precommit' }],
  },
  'healthy': {
    lie: 'reports a healthy construct on the control, where every property genuinely holds',
    ok: true,
    checks: [
      { id: 'lint-policy', state: 'present', level: 'L3' },
      { id: 'construct-tests', state: 'present', level: 'L3' },
      { id: 'ci', state: 'present', level: 'L3' },
      { id: 'hook', state: 'present', level: 'L2', evidence: 'lefthook.yml' },
      { id: 'red-gate', state: 'unknown', level: 'L3' },
    ],
    weakestLink: { id: 'hook', level: 'L2' },
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

function fileOps(root: string, directory = ''): FileOp[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const target = directory === '' ? entry.name : `${directory}/${entry.name}`
    if (entry.isDirectory())
      return fileOps(root, target)
    return [{ target, strategy: 'create', action: 'create', content: readFileSync(path.join(root, target), 'utf8') } satisfies FileOp]
  })
}

function materializeFixture(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `construct-doctor-${name}-`))
  cpSync(path.join(FIXTURES_DIR, name), root, { recursive: true })
  const manifest = buildManifest({
    version: VARS.constructVersion,
    preset: 'node-backend',
    ai: 'claude',
    review: 'none',
    vars: VARS,
    written: fileOps(root),
    contracts: false,
  })
  writeManifest(root, manifest)
  return root
}

function fixtureDirectories(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

function verdictFor(checks: CheckVerdict[], id: CheckId): CheckVerdict {
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
      expect(result?.checks.map(check => check.id)).toEqual([...CHECK_IDS])
      for (const expected of expectation.checks) {
        const verdict = verdictFor(result?.checks ?? [], expected.id)
        expect({ id: verdict.id, state: verdict.state, level: verdict.level }).toEqual({ id: expected.id, state: expected.state, level: expected.level })
        if (expected.evidence != null)
          expect(verdict.evidence).toContain(expected.evidence)
      }
      if (expectation.weakestLink !== undefined)
        expect(result?.weakestLink).toEqual(expectation.weakestLink)
    })
  }

  it('never claims L4, never calls CI absent and never resolves the red gate', () => {
    for (const name of Object.keys(FIXTURES)) {
      const checks = runDoctor(materializeFixture(name))?.checks ?? []
      expect(checks.map(check => check.level)).not.toContain('L4')
      expect(verdictFor(checks, 'ci').state).not.toBe('absent')
      expect(verdictFor(checks, 'red-gate').state).toBe('unknown')
      for (const check of checks)
        expect(check.evidence).not.toBe('')
    }
  })

  it('has one fixture directory per property doctor reports on, and one fixture per check id', () => {
    expect(fixtureDirectories().sort()).toEqual(Object.keys(FIXTURES).sort())
    const provoked = Object.entries(FIXTURES)
      .filter(([name]) => name !== CONTROL)
      .flatMap(([, expectation]) => expectation.checks.map(check => check.id))
    for (const id of CHECK_IDS)
      expect(provoked).toContain(id)
  })
})

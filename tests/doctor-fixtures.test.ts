import type { FileOp } from '../src/materialize/plan.js'
import type { TemplateVars } from '../src/presets/index.js'
import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/commands/doctor.js'
import { buildManifest, writeManifest } from '../src/manifest.js'

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures/doctor')

interface FixtureExpectation {
  lie: string
  ok: boolean
}

const FIXTURES: Record<string, FixtureExpectation> = {
  'broken-eslint-config': {
    lie: 'today reports a healthy construct on a repository whose eslint config never loads the construct policy',
    ok: true,
  },
  'orphaned-construct-tests': {
    lie: 'today reports a healthy construct on a repository whose construct tests fall outside the vitest include globs',
    ok: true,
  },
  'red-gate': {
    lie: 'today reports a healthy construct on a repository whose quality script fails on a clean checkout',
    ok: true,
  },
  'quality-not-in-ci': {
    lie: 'today reports a healthy construct on a repository where no workflow ever runs quality',
    ok: true,
  },
  'script-without-hook': {
    lie: 'today reports a healthy construct on a repository where a command is claimed as a guard with no hook manager and no core.hooksPath',
    ok: true,
  },
  'healthy': {
    lie: 'reports a healthy construct on the control, where every property genuinely holds',
    ok: true,
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

describe('doctor on the broken fixtures', () => {
  for (const [name, expectation] of Object.entries(FIXTURES)) {
    it(`${name}: ${expectation.lie}`, () => {
      const verdict = runDoctor(materializeFixture(name))
      expect(verdict?.ok).toBe(expectation.ok)
    })
  }

  it('has one fixture directory per property doctor will report on (this becomes an enumeration of doctor\'s own check ids once those exist)', () => {
    expect(fixtureDirectories().sort()).toEqual(Object.keys(FIXTURES).sort())
  })
})

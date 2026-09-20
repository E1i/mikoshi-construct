import type { DoctorResult, ResultFamily } from '../src/commands/doctor/index.js'
import type { OwnerReader } from '../src/model/ownership.js'
import type { RepositoryModel } from '../src/model/schema.js'
import type { TemplateVars } from '../src/presets/index.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECK_CLAIMS, CHECK_IDS, DOCTOR_FIELD_FAMILY, projectKnowledge } from '../src/commands/doctor/index.js'
import { deriveModelState } from '../src/model/state.js'
import { buildModel } from '../src/model/write.js'

const VARS: TemplateVars = {
  projectName: 'projection-fixture',
  scope: '@projection-fixture',
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

function model(sample = true): RepositoryModel {
  return buildModel({ vars: VARS, contracts: false, sample })
}

function scratch(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-projection-'))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
  return root
}

const HARNESS_IN_CI = {
  '.github/workflows/ci.yml': 'jobs:\n  quality:\n    steps:\n      - run: pnpm run quality\n',
  'scripts/tests/lint/syntax-policy.test.ts': 'import { ESLint } from \'eslint\'\n',
}

function result(overrides: Partial<DoctorResult> = {}): DoctorResult {
  return {
    ok: true,
    missingFiles: [],
    modifiedFiles: [],
    missingDiscovery: [],
    provenance: [],
    harnessProblems: [],
    uncollectedTests: [],
    warnings: [],
    checks: [],
    youAreHere: null,
    versionGap: { materializedBy: '0.1.0', readBy: '0.1.0', pending: 0 },
    ...overrides,
  }
}

function claimIdsNamedBy(value: unknown): string[] {
  if (Array.isArray(value))
    return value.flatMap(claimIdsNamedBy)
  if (typeof value !== 'object' || value == null)
    return []
  const record = value as Record<string, unknown>
  return [
    ...typeof record.claimId === 'string' ? [record.claimId] : [],
    ...Object.values(record).flatMap(claimIdsNamedBy),
  ]
}

function carriesAValue(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value != null
}

function synthesisedState(
  doctor: DoctorResult,
  repository: RepositoryModel,
  families: Record<string, ResultFamily> = DOCTOR_FIELD_FAMILY,
): string[] {
  const known = new Set(repository.claims.map(claim => claim.id))
  return Object.entries(families).flatMap(([field, family]) => {
    if (family !== 'knowledge')
      return []
    const value = (doctor as unknown as Record<string, unknown>)[field]
    const named = claimIdsNamedBy(value)
    return [
      ...carriesAValue(value) && named.length === 0 ? [`${field} carries a value that names no claim`] : [],
      ...named.filter(id => !known.has(id)).map(id => `${field} names "${id}", which the model does not carry`),
    ]
  })
}

describe('doctor\'s knowledge family is a projection of the model', () => {
  it('takes every verdict\'s level, state and evidence from the claim it renders', () => {
    const repository = model()
    const root = scratch(HARNESS_IN_CI)
    const derived = deriveModelState(repository, root)
    for (const verdict of projectKnowledge(repository, root).checks) {
      const claim = repository.claims.find(entry => entry.id === CHECK_CLAIMS[verdict.id])
      expect(claim?.id).toBe(verdict.claimId)
      expect(verdict.level).toBe(claim?.enforcement?.level)
      expect(verdict.state).toBe(derived.claims[verdict.claimId].enforcement)
      expect(verdict.evidence).toBe(claim?.enforcement?.mechanism)
    }
  })

  it('renders lint-policy only where the model carries that claim, and says nothing where it does not', () => {
    const root = scratch(HARNESS_IN_CI)
    expect(projectKnowledge(model(true), root).checks.map(check => check.id)).toEqual([...CHECK_IDS])
    expect(projectKnowledge(model(false), root).checks.map(check => check.id)).toEqual(['ci'])
  })

  it('takes where you are from the model\'s own path selection, and reports nothing where no chain stops', () => {
    const repository = model(false)
    expect(projectKnowledge(repository, scratch()).youAreHere).toEqual({ claimId: 'no-committed-secret', stage: 'enforcement', state: 'unsupported' })
    const held = scratch({
      ...HARNESS_IN_CI,
      '.github/workflows/security.yml': 'gitleaks\npnpm audit --audit-level=high\n',
      '.gitleaks.toml': '',
      'architecture/security-invariants.md': '',
      'eslint.config.mjs': '',
      'package.json': '{ "scripts": { "quality": "pnpm lint && pnpm typecheck && pnpm test" } }',
    })
    expect(projectKnowledge(repository, held).youAreHere).toBeNull()
  })

  it('holds no knowledge of its own where the repository carries no model', () => {
    expect(projectKnowledge(null, scratch())).toEqual({ checks: [], youAreHere: null })
  })
})

describe('the gate against state doctor synthesises', () => {
  it('passes on the projection as it stands, so the gate is not red for unrelated reasons', () => {
    const repository = model()
    const root = scratch(HARNESS_IN_CI)
    expect(synthesisedState(result(projectKnowledge(repository, root)), repository)).toEqual([])
  })

  it('fails when a knowledge-family verdict names a claim the model does not carry', () => {
    const repository = model()
    const root = scratch(HARNESS_IN_CI)
    const projection = projectKnowledge(repository, root)
    const invented = result({
      ...projection,
      checks: [...projection.checks, { ...projection.checks[0], claimId: 'a-claim-nobody-wrote' }],
    })
    expect(synthesisedState(invented, repository)).toEqual(['checks names "a-claim-nobody-wrote", which the model does not carry'])
  })

  it('fails when a knowledge-family field carries a value that traces to no claim at all', () => {
    const repository = model()
    expect(synthesisedState(result({ youAreHere: { claimId: '', stage: 'enforcement', state: 'unknown' } }), repository))
      .toContain('youAreHere names "", which the model does not carry')
  })

  it('asserts nothing about a mixed field, and covers one the moment it is reclassified', () => {
    const repository = model()
    const doctor = result({ harnessProblems: ['"quality" does not run test'] })
    expect(DOCTOR_FIELD_FAMILY.harnessProblems).toBe('mixed')
    expect(synthesisedState(doctor, repository)).toEqual([])
    expect(synthesisedState(doctor, repository, { ...DOCTOR_FIELD_FAMILY, harnessProblems: 'knowledge' }))
      .toEqual(['harnessProblems carries a value that names no claim'])
  })

  it('classifies every field of the doctor result, so no field escapes the question', () => {
    expect(Object.keys(DOCTOR_FIELD_FAMILY).sort()).toEqual(Object.keys(result()).sort())
  })
})

describe('the gate against ownership derived from anything but authoredBy', () => {
  function discoveryRewrote(repository: RepositoryModel): RepositoryModel {
    return {
      ...repository,
      claims: repository.claims.map(claim => claim.id === CHECK_CLAIMS.ci ? { ...claim, authoredBy: 'discovery' as const } : claim),
    }
  }

  function factsUnder(repository: RepositoryModel, id: string): string[] {
    return repository.claims.find(claim => claim.id === id)?.enforcement?.supportedBy ?? []
  }

  const IMPOSTORS: Record<string, (repository: RepositoryModel) => OwnerReader> = {
    'by position': repository => entry => repository.claims[0]?.id === entry.id ? 'construct' : 'unknown',
    'by what references it': repository => (entry) => {
      const stoodOn = factsUnder(repository, entry.id)
      const shared = repository.claims.some(claim => claim.id !== entry.id && factsUnder(repository, claim.id).some(fact => stoodOn.includes(fact)))
      return shared ? 'construct' : 'unknown'
    },
    'by preset membership': () => entry => model().claims.some(claim => claim.id === entry.id) ? 'construct' : 'unknown',
  }

  it('reads a discovery-authored claim as discovery, because authoredBy is the only source', () => {
    const repository = discoveryRewrote(model())
    const verdict = projectKnowledge(repository, scratch()).checks.find(check => check.id === 'ci')
    expect(verdict?.authoredBy).toBe('discovery')
  })

  for (const [derivation, impostor] of Object.entries(IMPOSTORS)) {
    it(`fails on a doctor deriving ownership ${derivation}`, () => {
      const repository = discoveryRewrote(model())
      const root = scratch()
      const honest = projectKnowledge(repository, root).checks.map(check => check.authoredBy)
      const derived = projectKnowledge(repository, root, impostor(repository)).checks.map(check => check.authoredBy)
      expect(derived).not.toEqual(honest)
    })
  }
})

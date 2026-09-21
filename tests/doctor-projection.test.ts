import type { ClaimPlacement, DoctorResult, ResultFamily } from '../src/commands/doctor/index.js'
import type { OwnerReader } from '../src/model/ownership.js'
import type { RepositoryModel } from '../src/model/schema.js'
import type { TemplateVars } from '../src/presets/index.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCTOR_FIELD_FAMILY, projectKnowledge, RESULT_FAMILIES } from '../src/commands/doctor/index.js'
import { MODEL_VERSION } from '../src/model/schema.js'
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
    unreadableFiles: [],
    missingDiscovery: [],
    provenance: [],
    harnessProblems: [],
    uncollectedTests: [],
    warnings: [],
    checks: [],
    hypotheses: [],
    youAreHere: { at: 'no-stop' },
    versionGap: { materializedBy: '0.1.0', readBy: '0.1.0', pending: 0 },
    ...overrides,
  }
}

function entryIdsNamedBy(value: unknown): string[] {
  if (Array.isArray(value))
    return value.flatMap(entryIdsNamedBy)
  if (typeof value !== 'object' || value == null)
    return []
  const record = value as Record<string, unknown>
  return [
    ...typeof record.claimId === 'string' ? [record.claimId] : [],
    ...typeof record.hypothesisId === 'string' ? [record.hypothesisId] : [],
    ...Object.values(record).flatMap(entryIdsNamedBy),
  ]
}

function placesNoClaim(value: unknown): boolean {
  return typeof value === 'object' && value != null && 'at' in value && (value as { at: unknown }).at !== 'stop'
}

function carriesAValue(value: unknown): boolean {
  if (Array.isArray(value))
    return value.length > 0
  return value != null && !placesNoClaim(value)
}

function synthesisedState(
  doctor: DoctorResult,
  repository: RepositoryModel,
  families: Record<string, ResultFamily> = DOCTOR_FIELD_FAMILY,
): string[] {
  const known = new Set([...repository.claims.map(claim => claim.id), ...repository.hypotheses.map(hypothesis => hypothesis.id)])
  return Object.entries(families).flatMap(([field, family]) => {
    if (family !== 'knowledge')
      return []
    const value = (doctor as unknown as Record<string, unknown>)[field]
    const named = entryIdsNamedBy(value)
    return [
      ...carriesAValue(value) && named.length === 0 ? [`${field} carries a value that names no entry of the model`] : [],
      ...named.filter(id => !known.has(id)).map(id => `${field} names "${id}", which the model does not carry`),
    ]
  })
}

describe('doctor\'s knowledge family is a projection of the model', () => {
  it('takes every verdict\'s level, state and mechanism from the claim it renders', () => {
    const repository = model()
    const root = scratch(HARNESS_IN_CI)
    const derived = deriveModelState(repository, root)
    for (const verdict of projectKnowledge(repository, root).checks) {
      const claim = repository.claims.find(entry => entry.id === verdict.claimId)
      expect(claim?.id).toBe(verdict.claimId)
      expect(verdict.level).toBe(claim?.enforcement?.level)
      expect(verdict.state).toBe(derived.claims[verdict.claimId].enforcement.state)
      expect(verdict.mechanism).toBe(claim?.enforcement?.mechanism)
    }
  })

  it('renders one verdict per claim, in the model\'s own declaration order', () => {
    const root = scratch(HARNESS_IN_CI)
    for (const sample of [true, false]) {
      const repository = model(sample)
      expect(projectKnowledge(repository, root).checks.map(check => check.claimId)).toEqual(repository.claims.map(claim => claim.id))
    }
  })

  it('names a verdict by the claim\'s legacy check id where it carries one, and by the claim id otherwise', () => {
    const repository = model(true)
    const rendered = projectKnowledge(repository, scratch(HARNESS_IN_CI)).checks
    expect(rendered.map(check => check.id)).toEqual(repository.claims.map(claim => claim.checkId ?? claim.id))
    expect(rendered.find(check => check.id === 'ci')?.claimId).toBe('every-change-passes-the-harness')
    expect(rendered.find(check => check.id === 'no-committed-secret')?.claimId).toBe('no-committed-secret')
  })

  it('renders the lint-policy claim only where the model carries it, and says nothing where it does not', () => {
    const root = scratch(HARNESS_IN_CI)
    expect(projectKnowledge(model(true), root).checks.map(check => check.id)).toContain('lint-policy')
    expect(projectKnowledge(model(false), root).checks.map(check => check.id)).not.toContain('lint-policy')
  })

  it('takes where you are from the model\'s own path selection, and reports nothing where no chain stops', () => {
    const repository = model(false)
    expect(projectKnowledge(repository, scratch()).youAreHere)
      .toEqual({ at: 'stop', stop: { claimId: 'no-committed-secret', stage: 'enforcement', state: 'unsupported', doesNotHold: ['.github/workflows/security.yml'] } })
    const held = scratch({
      ...HARNESS_IN_CI,
      '.github/workflows/security.yml': 'gitleaks\npnpm audit --audit-level=high\n',
      '.gitleaks.toml': '',
      'architecture/security-invariants.md': '',
      'eslint.config.mjs': '',
      'package.json': '{ "scripts": { "quality": "pnpm lint && pnpm typecheck && pnpm test" } }',
    })
    expect(projectKnowledge(repository, held).youAreHere).toEqual({ at: 'no-stop' })
  })

  it('holds no knowledge of its own where the repository carries no model, and says that is why', () => {
    expect(projectKnowledge(null, scratch())).toEqual({ checks: [], hypotheses: [], youAreHere: { at: 'no-model' } })
  })

  it('separates a model that carries no claim from no model at all, rather than leaving both an empty list', () => {
    const empty: RepositoryModel = { modelVersion: MODEL_VERSION, facts: [], claims: [], hypotheses: [] }
    expect(projectKnowledge(empty, scratch())).toEqual({ checks: [], hypotheses: [], youAreHere: { at: 'no-claim' } })
    expect(projectKnowledge(null, scratch()).youAreHere).not.toEqual(projectKnowledge(empty, scratch()).youAreHere)
  })

  it('separates a model whose every chain holds from one that carries no chain to hold', () => {
    const held = scratch({
      ...HARNESS_IN_CI,
      '.github/workflows/security.yml': 'gitleaks\npnpm audit --audit-level=high\n',
      '.gitleaks.toml': '',
      'architecture/security-invariants.md': '',
      'eslint.config.mjs': '',
      'package.json': '{ "scripts": { "quality": "pnpm lint && pnpm typecheck && pnpm test" } }',
    })
    expect(projectKnowledge(model(false), held).youAreHere).toEqual({ at: 'no-stop' })
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

  it('fails when a knowledge-family field carries a value that traces to no entry of the model at all', () => {
    const repository = model()
    expect(synthesisedState(result({ youAreHere: { at: 'stop', stop: { claimId: '', stage: 'enforcement', state: 'unknown', reason: 'no-fact-named' } } }), repository))
      .toContain('youAreHere names "", which the model does not carry')
  })

  it('covers harnessProblems by its classification alone, and says so the moment that classification changes', () => {
    const repository = model()
    const doctor = result({ harnessProblems: ['package.json is missing'] })
    expect(DOCTOR_FIELD_FAMILY.harnessProblems).toBe('provenance')
    expect(synthesisedState(doctor, repository)).toEqual([])
    expect(synthesisedState(doctor, repository, { ...DOCTOR_FIELD_FAMILY, harnessProblems: 'knowledge' }))
      .toEqual(['harnessProblems carries a value that names no entry of the model'])
  })

  it('classifies every field of the doctor result, so no field escapes the question', () => {
    expect(Object.keys(DOCTOR_FIELD_FAMILY).sort()).toEqual(Object.keys(result()).sort())
  })

  it('leaves no field in a family the code does not declare, so none abstains from the question', () => {
    expect(RESULT_FAMILIES).toEqual(['knowledge', 'provenance'])
    for (const [field, family] of Object.entries(DOCTOR_FIELD_FAMILY))
      expect(RESULT_FAMILIES, field).toContain(family)
  })
})

function stopAt(placement: ClaimPlacement): string | null {
  return placement.at === 'stop' ? placement.stop.claimId : null
}

function incomplete(doctor: DoctorResult, repository: RepositoryModel): string[] {
  const rendered = new Set(doctor.checks.map(check => check.claimId))
  const carried = new Set(repository.claims.map(claim => claim.id))
  return [
    ...[...carried].filter(id => !rendered.has(id)).map(id => `the model carries "${id}", which no verdict renders`),
    ...[...rendered].filter(id => !carried.has(id)).map(id => `a verdict renders "${id}", which the model does not carry`),
    ...doctor.youAreHere.at === 'stop' && !rendered.has(doctor.youAreHere.stop.claimId) ? [`you are here points at "${doctor.youAreHere.stop.claimId}", which no verdict renders`] : [],
  ]
}

describe('the gate against an Enforcement section that is not the whole model', () => {
  const repository = model()

  it('passes on the projection as it stands, in both directions at once', () => {
    const projection = projectKnowledge(repository, scratch(HARNESS_IN_CI))
    expect(incomplete(result(projection), repository)).toEqual([])
    expect(projection.checks).toHaveLength(repository.claims.length)
  })

  it('fails when the model carries a claim no verdict renders', () => {
    const projection = projectKnowledge(repository, scratch(HARNESS_IN_CI))
    const withheld = projection.checks[projection.checks.length - 1].claimId
    expect(stopAt(projection.youAreHere)).not.toBe(withheld)
    expect(incomplete(result({ ...projection, checks: projection.checks.slice(0, -1) }), repository))
      .toEqual([`the model carries "${withheld}", which no verdict renders`])
  })

  it('fails when a verdict renders a claim the model does not carry', () => {
    const projection = projectKnowledge(repository, scratch(HARNESS_IN_CI))
    const invented = [...projection.checks, { ...projection.checks[0], claimId: 'a-claim-nobody-wrote' }]
    expect(incomplete(result({ ...projection, checks: invented }), repository))
      .toEqual(['a verdict renders "a-claim-nobody-wrote", which the model does not carry'])
  })

  it('fails when you-are-here points at a claim the Enforcement section leaves out', () => {
    const projection = projectKnowledge(repository, scratch())
    expect(stopAt(projection.youAreHere)).toBe('no-committed-secret')
    expect(incomplete(result({ ...projection, checks: projection.checks.filter(check => check.claimId !== 'no-committed-secret') }), repository))
      .toContain('you are here points at "no-committed-secret", which no verdict renders')
  })

  it('holds on the repository doctor actually reads, where the model and the report are built apart', () => {
    const projection = projectKnowledge(repository, scratch())
    expect(incomplete(result(projection), repository)).toEqual([])
  })
})

describe('the gate against ownership derived from anything but authoredBy', () => {
  function discoveryRewrote(repository: RepositoryModel): RepositoryModel {
    return {
      ...repository,
      claims: repository.claims.map(claim => claim.id === 'every-change-passes-the-harness' ? { ...claim, authoredBy: 'discovery' as const } : claim),
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

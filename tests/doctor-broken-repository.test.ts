import type { CheckState, CheckVerdict, DoctorResult } from '../src/commands/doctor/index.js'
import type { FileOp } from '../src/materialize/plan.js'
import type { RepositoryModel } from '../src/model/schema.js'
import type { TemplateVars } from '../src/presets/index.js'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { printDoctor, runDoctor } from '../src/commands/doctor/index.js'
import { buildManifest, writeManifest } from '../src/manifest.js'
import { buildModel, writeModel } from '../src/model/write.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const HEALTHY = path.join(import.meta.dirname, 'fixtures/doctor/healthy')
const CI_WORKFLOW = '.github/workflows/ci.yml'
const BROKEN_CLAIM = 'every-change-passes-the-harness'
const BROKEN_CHECK = 'ci'

const PROVEN = /\b(?:proven|proves|guarantee)/i
const NOT_ENFORCED = /\b(?:not enforced|unenforced|no longer enforced|enforcement (?:is )?(?:gone|removed))/i
const ABSENT = /\b(?:absent|missing|does not exist|nobody wrote)/i

interface BrokenRepository {
  reads: string
  break: (root: string) => void
  model?: (model: RepositoryModel) => RepositoryModel
  state: CheckState
  names: string[]
  saysNothingWasRead: boolean
}

const REPOSITORIES: Record<string, BrokenRepository> = {
  'a-fact-that-does-not-hold': {
    reads: 'the workflow the claim stands on was renamed away',
    break: root => rmSync(path.join(root, CI_WORKFLOW)),
    state: 'unsupported',
    names: [CI_WORKFLOW],
    saysNothingWasRead: false,
  },
  'a-fact-that-cannot-be-evaluated': {
    reads: 'a directory stands where the claim expects a file, so the read fails',
    break: (root) => {
      rmSync(path.join(root, CI_WORKFLOW))
      mkdirSync(path.join(root, CI_WORKFLOW))
    },
    state: 'unknown',
    names: [CI_WORKFLOW],
    saysNothingWasRead: true,
  },
  'no-fact-named-under-the-stage': {
    reads: 'the claim names no fact at all, so nothing under it was looked at',
    break: () => {},
    model: model => ({
      ...model,
      claims: model.claims.map(claim => claim.id === BROKEN_CLAIM && claim.enforcement != null
        ? { ...claim, enforcement: { ...claim.enforcement, supportedBy: [] } }
        : claim),
    }),
    state: 'unknown',
    names: [],
    saysNothingWasRead: true,
  },
}

const VARS: TemplateVars = {
  projectName: 'broken-fixture',
  scope: '@broken-fixture',
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

function repository(name: string): string {
  const fixture = REPOSITORIES[name]
  const root = mkdtempSync(path.join(tmpdir(), `construct-broken-${name}-`))
  cpSync(HEALTHY, root, { recursive: true })
  fixture.break(root)
  writeManifest(root, buildManifest({
    version: VARS.constructVersion,
    preset: 'node-backend',
    ai: 'claude',
    review: 'none',
    vars: VARS,
    written: fileOps(root),
    ownedShas: {},
    contracts: false,
    previous: null,
    policy: null,
  }))
  const model = buildModel({ vars: VARS, contracts: false, sample: true })
  writeModel(root, fixture.model == null ? model : fixture.model(model))
  return root
}

function verdictFor(result: DoctorResult | null, id: string): CheckVerdict {
  const verdict = result?.checks.find(check => check.id === id)
  if (verdict == null)
    throw new Error(`doctor reported no verdict for "${id}"`)
  return verdict
}

function lineFor(result: DoctorResult, id: string): string {
  const lines: string[] = []
  const ui = createUi(resolveTheme({ plain: true, johnny: false }), text => lines.push(text))
  printDoctor(ui, result)
  const line = lines.join('').split('\n').find(text => text.trimStart().startsWith(`${id} `))
  if (line == null)
    throw new Error(`the report carries no line for "${id}"`)
  return line
}

function healthyControl(): DoctorResult {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-broken-control-'))
  cpSync(HEALTHY, root, { recursive: true })
  writeManifest(root, buildManifest({
    version: VARS.constructVersion,
    preset: 'node-backend',
    ai: 'claude',
    review: 'none',
    vars: VARS,
    written: fileOps(root),
    ownedShas: {},
    contracts: false,
    previous: null,
    policy: null,
  }))
  writeModel(root, buildModel({ vars: VARS, contracts: false, sample: true }))
  return runDoctor(root) as DoctorResult
}

describe('doctor on a repository built broken on purpose', () => {
  for (const [name, fixture] of Object.entries(REPOSITORIES)) {
    it(`${name}: reports ${fixture.state} where ${fixture.reads}`, () => {
      const result = runDoctor(repository(name)) as DoctorResult
      const verdict = verdictFor(result, BROKEN_CHECK)
      const line = lineFor(result, BROKEN_CHECK)

      expect(verdict.state).toBe(fixture.state)
      expect(line).toContain(fixture.state)
      expect(line).toContain(verdict.mechanism.slice(0, 40))
      for (const named of fixture.names)
        expect(line).toContain(named)
      expect(result.ok).toBe(true)
    })
  }

  it('reads a fact it could not evaluate as unknown, and never as a fact that does not hold', () => {
    const verdict = verdictFor(runDoctor(repository('a-fact-that-cannot-be-evaluated')), BROKEN_CHECK)

    expect(verdict.state).toBe('unknown')
    expect(verdict.state).not.toBe('unsupported')
    expect(verdict).toEqual(expect.objectContaining({ reason: 'unevaluable', unevaluable: [CI_WORKFLOW] }))
    expect(verdict).not.toHaveProperty('doesNotHold')
  })

  it('names no fact where the stage names none, rather than inventing one to blame', () => {
    const verdict = verdictFor(runDoctor(repository('no-fact-named-under-the-stage')), BROKEN_CHECK)

    expect(verdict).toEqual(expect.objectContaining({ state: 'unknown', reason: 'no-fact-named' }))
    expect(verdict).not.toHaveProperty('doesNotHold')
    expect(verdict).not.toHaveProperty('unevaluable')
  })

  it('says what could not be read where nothing was read, and says nothing of the kind where a fact was', () => {
    for (const [name, fixture] of Object.entries(REPOSITORIES)) {
      const line = lineFor(runDoctor(repository(name)) as DoctorResult, BROKEN_CHECK)
      expect(/could not be read|nothing was read/.test(line), name).toBe(fixture.saysNothingWasRead)
    }
  })

  it('reaches the same facts through you-are-here as through the verdict, from the one derivation', () => {
    for (const name of Object.keys(REPOSITORIES)) {
      const result = runDoctor(repository(name)) as DoctorResult
      const verdict = verdictFor(result, BROKEN_CHECK)
      const { claimId, stage, ...finding } = result.youAreHere.at === 'stop' ? result.youAreHere.stop : { claimId: '', stage: 'enforcement' as const }
      const { id, claimId: rendered, level, authoredBy, mechanism, ...verdictFinding } = verdict

      expect(claimId, name).toBe(BROKEN_CLAIM)
      expect(stage, name).toBe('enforcement')
      expect(finding, name).toEqual(verdictFinding)
    }
  })

  it('renders held as a state and not as proof, on the control every fixture is broken from', () => {
    const control = healthyControl()

    for (const check of control.checks.filter(verdict => verdict.state === 'held'))
      expect(lineFor(control, check.id)).not.toMatch(PROVEN)
    expect(control.checks.map(check => check.state)).toContain('held')
  })

  it('renders unsupported as facts that no longer match and not as enforcement that is gone', () => {
    const result = runDoctor(repository('a-fact-that-does-not-hold')) as DoctorResult
    const line = lineFor(result, BROKEN_CHECK)

    expect(line).not.toMatch(NOT_ENFORCED)
    expect(line).toContain('no longer matching')
    expect(line).toContain('expects')
  })

  it('renders unknown as nothing said and not as something absent', () => {
    for (const name of ['a-fact-that-cannot-be-evaluated', 'no-fact-named-under-the-stage']) {
      const line = lineFor(runDoctor(repository(name)) as DoctorResult, BROKEN_CHECK)
      expect(line, name).not.toMatch(ABSENT)
      expect(line, name).not.toMatch(NOT_ENFORCED)
      expect(line, name).not.toContain('no longer matching')
    }
  })

  it('leaves the exit code and the provenance family alone, since a stopped chain is not a fault', () => {
    const control = healthyControl()

    for (const name of Object.keys(REPOSITORIES)) {
      const result = runDoctor(repository(name)) as DoctorResult
      expect(result.ok, name).toBe(true)
      expect(result.missingDiscovery, name).toEqual(control.missingDiscovery)
      expect(printDoctor(createUi(resolveTheme({ plain: true, johnny: false }), () => {}), result), name).toBe(0)
    }
  })
})

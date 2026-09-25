import type { DoctorResult } from '../src/commands/doctor/index.js'
import type { Fact, RepositoryModel } from '../src/model/schema.js'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { runDoctor } from '../src/commands/doctor/index.js'
import { modelPicture } from '../src/commands/graph.js'
import { runInit } from '../src/commands/init.js'
import { buildManifest, readManifest, recordedShas, writeManifest } from '../src/manifest.js'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'
import { readModel } from '../src/model/write.js'
import { getPreset, PRESET_IDS } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/verification')
const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const RECORDED_ROOT = '/construct-fixture-root/'
const REPORT = 'reports/vitest.json'
const CLAIM = 'harness-covers-target'
const MISSES_HYPOTHESIS = 'harness-misses-the-python-tests'
const SURFACE_TIME = new Date('2026-01-01T00:00:00Z')
const REPORT_TIME = new Date('2026-01-01T00:01:00Z')
const LATER_THAN_THE_REPORT = new Date('2026-01-01T00:02:00Z')

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
}

function placeReport(root: string, source: string): void {
  const recorded = readFileSync(path.join(root, source), 'utf8')
  mkdirSync(path.dirname(path.join(root, REPORT)), { recursive: true })
  writeFileSync(path.join(root, REPORT), recorded.replaceAll(RECORDED_ROOT, `${root}/`))
}

function settleTimes(root: string): void {
  for (const file of filesUnder(root))
    utimesSync(file, SURFACE_TIME, SURFACE_TIME)
  if (filesUnder(root).includes(path.join(root, REPORT)))
    utimesSync(path.join(root, REPORT), REPORT_TIME, REPORT_TIME)
}

function copyOf(fixture: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `construct-coverage-${fixture}-`)))
  cpSync(path.join(FIXTURES, fixture), root, { recursive: true })
  return root
}

function editModel(root: string, edit: (model: RepositoryModel) => RepositoryModel): void {
  const model = readModel(root)
  if (model == null)
    throw new Error(`${root} carries no ${MODEL_FILE}`)
  writeFileSync(path.join(root, MODEL_FILE), `${JSON.stringify(edit(model), null, 2)}\n`)
}

function withSurface(surface: string[]): (model: RepositoryModel) => RepositoryModel {
  return model => ({ ...model, facts: model.facts.map(fact => fact.surface == null ? fact : { ...fact, surface }) })
}

interface PythonVariant {
  surface?: string[]
  report?: 'real' | 'absent' | 'one-entry-unmapped'
  surfaceNewerThanReport?: boolean
  claim?: 'present' | 'absent'
}

function pythonService(variant: PythonVariant = {}): string {
  const root = copyOf('python-service')
  if (variant.report === 'absent')
    rmSync(path.join(root, REPORT))
  else
    placeReport(root, REPORT)
  if (variant.report === 'one-entry-unmapped') {
    const report = JSON.parse(readFileSync(path.join(root, REPORT), 'utf8')) as { testResults: { name: string }[] }
    report.testResults[0].name = '/somewhere/else/entirely/files.test.ts'
    writeFileSync(path.join(root, REPORT), JSON.stringify(report))
  }
  if (variant.surface != null)
    editModel(root, withSurface(variant.surface))
  if (variant.claim === 'absent')
    editModel(root, model => ({ ...model, claims: model.claims.filter(claim => claim.id !== CLAIM) }))
  settleTimes(root)
  if (variant.surfaceNewerThanReport === true)
    utimesSync(path.join(root, 'tests/test_api.py'), LATER_THAN_THE_REPORT, LATER_THAN_THE_REPORT)
  return root
}

function nodeService(report: 'skipped' | 'failed'): string {
  const root = copyOf('node-service')
  writeManifest(root, buildManifest({
    version: '0.0.0-fixture',
    preset: 'node-library',
    ai: 'claude',
    review: 'none',
    vars: {
      projectName: 'node-service',
      scope: '@node-service',
      nodeMajor: '24',
      contracts: 'false',
      contractPath: '',
      contractTypesOutput: '',
      compositionDir: 'architecture/composition',
      harnessCommand: 'pnpm run quality',
      packageManager: 'pnpm',
      pnpmVersion: '',
      reviewModel: '',
      constructVersion: '0.0.0-fixture',
    },
    written: [],
    ownedShas: {},
    contracts: false,
    previous: null,
    policy: null,
  }))
  placeReport(root, `reports/${report}.json`)
  settleTimes(root)
  return root
}

function doctor(root: string): DoctorResult {
  const result = runDoctor(root)
  if (result == null)
    throw new Error(`${root} carries no construct.json`)
  return result
}

function coverageClaim(root: string): string | undefined {
  const model = readModel(root)
  const manifest = readManifest(root)
  if (model == null || manifest == null)
    return undefined
  return deriveModelState(model, root, { reports: 'read', constructPaths: Object.keys(recordedShas(manifest)) }).claims[CLAIM]?.verification.state
}

function missesHypothesis(root: string): string | undefined {
  return doctor(root).hypotheses.find(hypothesis => hypothesis.hypothesisId === MISSES_HYPOTHESIS)?.state
}

const UNEVALUABLE_VARIANTS: [string, PythonVariant][] = [
  ['without its report', { report: 'absent' }],
  ['with a surface file newer than the report', { surfaceNewerThanReport: true }],
  ['with one report entry that maps to no repository path and no surface hit', { report: 'one-entry-unmapped' }],
  ['with a surface glob that matches no file', { surface: ['tests/**/*.feature'] }],
]

describe('harness.state on the python service of measurement 2a, whose harness ran only the construct\'s own tests', () => {
  it('reads does-not-cover with its real Vitest report and the surface tests/**/test_*.py', () => {
    expect(doctor(pythonService()).harness).toEqual({ command: 'pnpm run quality', state: 'does-not-cover' })
  })

  it('reads does-not-cover with the surface **/*, because every file the report executed is the construct\'s own', () => {
    expect(doctor(pythonService({ surface: ['**/*'] })).harness.state).toBe('does-not-cover')
  })

  it('keeps ok true while it reads does-not-cover, because ok answers whether the inspection completed', () => {
    const result = doctor(pythonService())
    expect(result.harness.state).toBe('does-not-cover')
    expect(result.ok).toBe(true)
  })

  it('reads unknown when the model carries no harness-covers-target', () => {
    expect(doctor(pythonService({ claim: 'absent' })).harness.state).toBe('unknown')
  })

  it.each(UNEVALUABLE_VARIANTS)('reads unknown %s', (_name, variant) => {
    expect(doctor(pythonService(variant)).harness.state).toBe('unknown')
  })

  it('reads the report-misses hypothesis as held where report-covers does not hold', () => {
    expect(missesHypothesis(pythonService())).toBe('held')
  })

  it.each(UNEVALUABLE_VARIANTS)('reads the report-misses hypothesis as unknown %s', (_name, variant) => {
    expect(missesHypothesis(pythonService(variant))).toBe('unknown')
  })

  it('never reads checked, and never leaves its coverage claim held, under any variant', () => {
    const variants: PythonVariant[] = [{}, { surface: ['**/*'] }, { claim: 'absent' }, ...UNEVALUABLE_VARIANTS.map(([, variant]) => variant)]
    const readings = variants.map((variant) => {
      const root = pythonService(variant)
      return { harness: doctor(root).harness.state, claim: coverageClaim(root) }
    })
    expect(readings.filter(reading => reading.harness === 'checked' || reading.claim === 'held')).toEqual([])
    expect(new Set(readings.map(reading => reading.harness))).toEqual(new Set(['does-not-cover', 'unknown']))
  })
})

describe('harness.state reads coverage of the surface, not the outcome of the run', () => {
  it('reads does-not-cover when the report lists the only surface entry as skipped', () => {
    expect(doctor(nodeService('skipped')).harness.state).toBe('does-not-cover')
  })

  it('reads checked when the report lists the surface entry as failed, because a failed element was run', () => {
    expect(doctor(nodeService('failed')).harness.state).toBe('checked')
  })
})

describe('the picture never reads a runner\'s report', () => {
  function pictureOf(root: string): string {
    const picture = modelPicture(root)
    return picture.at === 'drawn' ? picture.mermaid : picture.at
  }

  it('draws the node service the same with a failed report, with no report and with a stale report', () => {
    const failed = pictureOf(nodeService('failed'))
    const absent = nodeService('failed')
    rmSync(path.join(absent, REPORT))
    const stale = nodeService('failed')
    utimesSync(path.join(stale, 'tests/sum.test.js'), LATER_THAN_THE_REPORT, LATER_THAN_THE_REPORT)
    expect(failed).toContain('runtime report, read by doctor')
    expect(pictureOf(absent)).toBe(failed)
    expect(pictureOf(stale)).toBe(failed)
  })

  it('never draws the python service\'s coverage claim held, under any variant', () => {
    for (const variant of [{}, { surface: ['**/*'] }, ...UNEVALUABLE_VARIANTS.map(([, entry]) => entry)]) {
      const line = pictureOf(pythonService(variant)).split('\n').find(entry => entry.includes(`${CLAIM}<br/>`))
      expect(line).toContain('verification runtime report, read by doctor')
    }
  })
})

describe('the construct never writes harness-covers-target', () => {
  for (const presetId of PRESET_IDS) {
    if (!getPreset(presetId).available)
      continue

    it(`${presetId}: init writes a model with no harness-covers-target and no report fact`, async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'construct-coverage-init-'))
      await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: presetId, name: 'coverage-fixture', yes: true, dryRun: false })
      const model = parseModel(readFileSync(path.join(dir, MODEL_FILE), 'utf8'), MODEL_FILE)
      expect(model.claims.map(claim => claim.id)).not.toContain(CLAIM)
      expect(model.facts.filter(fact => fact.kind === 'report-covers' || fact.kind === 'report-misses')).toEqual([])
    })
  }
})

describe('file-lacks never turns a file it could not read into an observation', () => {
  const NEEDLE = 'pnpm run quality'

  function lacking(file: string, body: string | null): string | undefined {
    const root = mkdtempSync(path.join(tmpdir(), 'construct-file-lacks-'))
    if (body != null)
      writeFileSync(path.join(root, file), body)
    const fact: Fact = { id: 'lacks', kind: 'file-lacks', path: file, authoredBy: 'discovery', needle: NEEDLE }
    const model: RepositoryModel = {
      modelVersion: MODEL_VERSION,
      facts: [fact],
      claims: [],
      hypotheses: [{ id: 'h', statement: 'the file does not run the harness', authoredBy: 'discovery', baseSha: null, evidenceClean: true, supportedBy: ['lacks'] }],
    }
    return deriveModelState(model, root).hypotheses.h?.state
  }

  it('reads unknown on a missing file', () => {
    expect(lacking('ci.yml', null)).toBe('unknown')
  })

  it('reads held on a file without the needle', () => {
    expect(lacking('ci.yml', 'run: make check\n')).toBe('held')
  })

  it('reads unsupported on a file with the needle', () => {
    expect(lacking('ci.yml', `run: ${NEEDLE}\n`)).toBe('unsupported')
  })
})

describe('the model format is version 2', () => {
  it('writes modelVersion 2, which a reader of version 1 reads as ahead of it (0028)', () => {
    expect(MODEL_VERSION).toBe(2)
    expect(JSON.parse(readFileSync(path.join(FIXTURES, 'python-service', MODEL_FILE), 'utf8')).modelVersion).toBe(2)
  })

  it('still reads a version 1 model, which every repository initialised before it carries', () => {
    expect(parseModel(JSON.stringify({ modelVersion: 1, facts: [], claims: [], hypotheses: [] }), MODEL_FILE).modelVersion).toBe(MODEL_VERSION)
  })

  it('allows a surface only on the report kinds', () => {
    const document = (fact: object): string => JSON.stringify({ modelVersion: 2, facts: [{ id: 'a', path: 'r.json', authoredBy: 'discovery', ...fact }], claims: [], hypotheses: [] })
    expect(() => parseModel(document({ kind: 'file-exists', surface: ['**/*'] }), 'M')).toThrow('facts[0] of kind "file-exists" must not carry a "surface"')
    expect(() => parseModel(document({ kind: 'report-covers' }), 'M')).toThrow('facts[0] of kind "report-covers" needs a "surface" list of non-empty globs')
    expect(() => parseModel(document({ kind: 'report-misses', surface: [] }), 'M')).toThrow('needs a "surface" list of non-empty globs')
    expect(() => parseModel(document({ kind: 'file-lacks' }), 'M')).toThrow('facts[0] of kind "file-lacks" needs a non-empty "needle"')
  })
})

describe('this repository reads checked on itself', () => {
  const SELF_REPORT = '.construct/reports/vitest.json'

  it('carries harness-covers-target, authored by discovery, on a report-covers fact over tests/**/*.test.ts', () => {
    const model = readModel(REPO_ROOT)
    const claim = model?.claims.find(entry => entry.id === CLAIM)
    const facts = (claim?.verification?.supportedBy ?? []).map(id => model?.facts.find(fact => fact.id === id))
    expect(claim?.authoredBy).toBe('discovery')
    expect(facts).toEqual([expect.objectContaining({ kind: 'report-covers', path: SELF_REPORT, surface: ['tests/**/*.test.ts'], authoredBy: 'discovery' })])
  })

  it('writes that report in CI\'s quality job and fails unless doctor reads checked', () => {
    const workflow = YAML.parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: { quality: { steps: { run?: string }[] } } }
    const runs = workflow.jobs.quality.steps.map(step => step.run ?? '').join('\n')
    expect(runs).toContain(`--reporter=json --outputFile=${SELF_REPORT}`)
    expect(runs).toContain('doctor --json')
    expect(runs).toContain('"checked"')
  })

  it('never commits the report', () => {
    const lines = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8').split('\n')
    const block = lines.slice(lines.indexOf('# construct:begin'), lines.indexOf('# construct:end') + 1)
    expect(lines.filter(line => line === SELF_REPORT)).toHaveLength(1)
    expect(block).not.toContain(SELF_REPORT)
  })
})

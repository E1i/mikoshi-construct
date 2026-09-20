import type { PresetId, TemplateVars } from '../src/presets/index.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detect } from '../src/detect/index.js'
import { planMaterialize } from '../src/materialize/plan.js'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'
import { buildModel, writeModel } from '../src/model/write.js'
import { aiGroups, getPreset, PRESET_IDS } from '../src/presets/index.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const FRESH_INIT = path.resolve(import.meta.dirname, 'fixtures/model/fresh-init/construct.model.json')

const VARS: TemplateVars = {
  projectName: 'pinned-fixture',
  scope: '@pinned-fixture',
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

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-model-'))
}

function presetVars(dir: string, presetId: PresetId): TemplateVars {
  const preset = getPreset(presetId)
  return { ...VARS, contracts: preset.contracts ? 'true' : 'false', ...preset.vars(detect(dir), VARS.projectName) }
}

function materializedContent(presetId: PresetId): Record<string, string> {
  const dir = scratch()
  const preset = getPreset(presetId)
  const vars = presetVars(dir, presetId)
  const plan = planMaterialize(dir, [...preset.groups, ...aiGroups('claude')], vars, { emptyTarget: true, ai: 'claude' })
  return Object.fromEntries(plan.ops.map(op => [op.target, op.content]))
}

describe('the model init writes', () => {
  it('restates what a fresh materialization already carries, with no hypothesis and both stages of every claim supported', () => {
    const model = buildModel({ vars: VARS, contracts: false })
    expect(model).toEqual(parseModel(readFileSync(FRESH_INIT, 'utf8'), 'fresh-init'))
    expect(model.modelVersion).toBe(MODEL_VERSION)
    expect(model.hypotheses).toEqual([])
    for (const claim of model.claims) {
      expect(claim.enforcement?.supportedBy.length, claim.id).toBeGreaterThan(0)
      expect(claim.verification?.supportedBy.length, claim.id).toBeGreaterThan(0)
    }
  })

  it('takes no wall clock and no ambient read: the same input builds the same model', () => {
    expect(buildModel({ vars: VARS, contracts: false })).toEqual(buildModel({ vars: VARS, contracts: false }))
    expect(JSON.stringify(buildModel({ vars: { ...VARS, contractPath: 'contracts/api/openapi.yaml' }, contracts: true }))).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('adds the contract claim only where the construct materializes a contract', () => {
    const without = buildModel({ vars: VARS, contracts: false })
    const with_ = buildModel({ vars: { ...VARS, contractPath: 'contracts/api/openapi.yaml' }, contracts: true })
    expect(without.claims.map(claim => claim.id)).not.toContain('a-breaking-api-change-is-named-before-it-ships')
    expect(with_.claims.map(claim => claim.id)).toContain('a-breaking-api-change-is-named-before-it-ships')
    expect(with_.facts.some(fact => fact.path === 'contracts/api/openapi.yaml')).toBe(true)
  })

  for (const presetId of PRESET_IDS) {
    it(`${presetId}: grounds every fact in a file that preset really materializes`, () => {
      const preset = getPreset(presetId)
      const content = materializedContent(presetId)
      const dir = scratch()
      const model = buildModel({ vars: presetVars(dir, presetId), contracts: preset.contracts })
      expect(model.facts.length).toBeGreaterThan(0)
      for (const fact of model.facts) {
        expect(Object.keys(content), `${fact.id} names a file the construct does not write`).toContain(fact.path)
        if (fact.kind === 'file-contains')
          expect(content[fact.path], `${fact.id} names a needle absent from ${fact.path}`).toContain(fact.needle)
      }
    })
  }

  it('writes construct.model.json the way the manifest is written: two-space JSON and a trailing newline', () => {
    const dir = scratch()
    const model = buildModel({ vars: VARS, contracts: false })
    writeModel(dir, model)
    const source = readFileSync(path.join(dir, MODEL_FILE), 'utf8')
    expect(source).toBe(`${JSON.stringify(model, null, 2)}\n`)
    expect(parseModel(source, MODEL_FILE)).toEqual(model)
  })

  it('is the model this repository commits, built from its own manifest rather than by hand', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'construct.json'), 'utf8')) as { vars: TemplateVars, contracts: unknown }
    const committed = readFileSync(path.join(REPO_ROOT, MODEL_FILE), 'utf8')
    const model = buildModel({ vars: manifest.vars, contracts: manifest.contracts != null })
    expect(parseModel(committed, MODEL_FILE)).toEqual(model)
    expect(committed).toBe(`${JSON.stringify(model, null, 2)}\n`)
  })
})

import type { PresetId, TemplateVars } from '../src/presets/index.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detect } from '../src/detect/index.js'
import { planMaterialize } from '../src/materialize/plan.js'
import { buildModel } from '../src/model/write.js'
import { aiGroups, getPreset, PRESET_IDS } from '../src/presets/index.js'

const MANIFEST = 'package.json'
const HARNESS_STEPS = 'harness-steps'

const VARS: TemplateVars = {
  projectName: 'needle-fixture',
  scope: '@needle-fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: '',
  contractTypesOutput: '',
  compositionDir: 'architecture/composition',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: 'claude-sonnet-5',
  constructVersion: '0.0.0-fixture',
}

function varsFor(dir: string, presetId: PresetId): TemplateVars {
  const preset = getPreset(presetId)
  return { ...VARS, contracts: preset.contracts ? 'true' : 'false', ...preset.vars(detect(dir), VARS.projectName, null) }
}

function qualityScript(presetId: PresetId): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-needle-'))
  const preset = getPreset(presetId)
  const vars = varsFor(dir, presetId)
  const plan = planMaterialize(dir, [...preset.groups, ...aiGroups('claude')], vars, { emptyTarget: true, ai: 'claude' })
  const manifest = plan.ops.find(op => op.target === MANIFEST)
  if (manifest == null)
    throw new Error(`${presetId} materializes no ${MANIFEST}`)
  const scripts = (JSON.parse(manifest.content) as { scripts?: Record<string, string> }).scripts ?? {}
  const quality = scripts.quality
  if (quality == null)
    throw new Error(`${presetId} materializes no quality script`)
  return quality
}

function harnessStepsNeedles(presetId: PresetId): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-needle-'))
  const preset = getPreset(presetId)
  const model = buildModel({ vars: varsFor(dir, presetId), contracts: preset.contracts, sample: true })
  const claim = model.claims.find(entry => entry.id === HARNESS_STEPS)
  if (claim == null)
    throw new Error(`${presetId} builds no ${HARNESS_STEPS} claim`)
  const stands = new Set(claim.enforcement?.supportedBy ?? [])
  return model.facts
    .filter(fact => stands.has(fact.id) && fact.path === MANIFEST && fact.needle != null)
    .map(fact => fact.needle as string)
}

describe('every harness-steps needle is a step the template actually writes', () => {
  for (const presetId of PRESET_IDS) {
    if (!getPreset(presetId).available)
      continue

    it(`${presetId}: each needle is a substring of the rendered quality script`, () => {
      const quality = qualityScript(presetId)
      const needles = harnessStepsNeedles(presetId)

      expect(needles.length).toBeGreaterThan(0)
      for (const needle of needles)
        expect(quality, `${presetId} quality script`).toContain(needle)
    })

    it(`${presetId}: every step of the quality script is named by a needle`, () => {
      const steps = qualityScript(presetId).split('&&').map(step => step.trim()).filter(step => step !== '')
      const needles = harnessStepsNeedles(presetId)

      expect(steps.filter(step => !needles.some(needle => step.includes(needle)))).toEqual([])
    })
  }
})

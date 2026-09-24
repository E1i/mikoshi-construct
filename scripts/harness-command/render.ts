import type { PresetId, TemplateVars } from '../../src/presets/index.js'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detect } from '../../src/detect/index.js'
import { planMaterialize } from '../../src/materialize/plan.js'
import { getPreset, groupsFor, PRESET_IDS } from '../../src/presets/index.js'

export const CONVERTED_TARGETS = ['AGENTS.md', '.github/workflows/ci.yml'] as const

export const PNPM_HARNESS = 'pnpm run quality'

export const PNPM_OUTPUT_FIXTURE = path.resolve(import.meta.dirname, '../../tests/fixtures/harness-command/pnpm-output.json')

const FIXTURE_VARS: TemplateVars = {
  projectName: 'harness-command-fixture',
  scope: '@harness-command-fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: 'contracts/api/openapi.yaml',
  contractTypesOutput: 'src/contracts/openapi.ts',
  compositionDir: 'architecture/composition',
  harnessCommand: PNPM_HARNESS,
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: 'claude-sonnet-5',
  constructVersion: '0.0.0-fixture',
}

export function availablePresets(): PresetId[] {
  return PRESET_IDS.filter(id => getPreset(id).available)
}

export function renderInit(presetId: PresetId, harnessCommand: string): Map<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-harness-command-'))
  try {
    const preset = getPreset(presetId)
    const vars = { ...FIXTURE_VARS, contracts: preset.contracts ? 'true' : 'false', ...preset.vars(detect(dir), FIXTURE_VARS.projectName, null), harnessCommand }
    const plan = planMaterialize(dir, groupsFor(preset, 'both', 'claude'), vars, { emptyTarget: true, ai: 'both' })
    return new Map(plan.ops.map(op => [op.target, op.content]))
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export type ConvertedDigests = Record<string, Record<string, string>>

export function convertedDigests(harnessCommand: string): ConvertedDigests {
  return Object.fromEntries(availablePresets().map((presetId) => {
    const rendered = renderInit(presetId, harnessCommand)
    return [presetId, Object.fromEntries(CONVERTED_TARGETS.map(target => [target, sha256(rendered.get(target) ?? '')]))]
  }))
}

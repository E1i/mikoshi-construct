import type { Manifest } from '../src/manifest.js'
import type { PresetId, TemplateVars } from '../src/presets/index.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { MANIFEST_FILE } from '../src/manifest.js'
import { MODEL_FILE, parseModel } from '../src/model/schema.js'
import { buildModel } from '../src/model/write.js'
import { getPreset, PRESET_IDS, sampleGroups } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

async function materialized(presetId: PresetId): Promise<{ manifest: Manifest, carried: string[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-expected-'))
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: presetId, name: 'expected-fixture', yes: true, dryRun: false })
  return {
    manifest: JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')) as Manifest,
    carried: parseModel(readFileSync(path.join(dir, MODEL_FILE), 'utf8'), MODEL_FILE).claims.map(claim => claim.id).sort(),
  }
}

function expectedFrom(manifest: Manifest): string[] {
  return buildModel({
    vars: manifest.vars as TemplateVars,
    contracts: manifest.contracts != null,
    sample: sampleGroups(getPreset(manifest.preset)).length > 0,
  }).claims.map(claim => claim.id).sort()
}

describe('what a preset can claim is derivable from the manifest alone', () => {
  for (const presetId of PRESET_IDS) {
    if (!getPreset(presetId).available)
      continue

    it(`${presetId}: buildModel from the recorded preset and vars yields exactly the claims the model carries`, async () => {
      const { manifest, carried } = await materialized(presetId)

      expect(expectedFrom(manifest)).toEqual(carried)
    })
  }
})

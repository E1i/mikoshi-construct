import type { TemplateVars } from '../src/presets/index.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { printDoctor, runDoctor } from '../src/commands/doctor/index.js'
import { buildManifest, writeManifest } from '../src/manifest.js'
import { MODEL_FILE } from '../src/model/schema.js'
import { buildModel, writeModel } from '../src/model/write.js'
import { createUi } from '../src/ui/console.js'
import { LORE, PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'

const VARS: TemplateVars = {
  projectName: 'no-model-fixture',
  scope: '@no-model-fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: '',
  contractTypesOutput: '',
  compositionDir: 'architecture/composition',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: '',
  constructVersion: '0.0.0-fixture',
}

function repository(withModel: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-no-model-'))
  writeFileSync(path.join(root, 'package.json'), '{ "scripts": { "quality": "pnpm composition:check && pnpm lint && pnpm typecheck && pnpm test" } }')
  writeManifest(root, buildManifest({
    version: '0.0.0-fixture',
    preset: 'node-library',
    ai: 'claude',
    review: 'none',
    vars: VARS,
    written: [],
    contracts: false,
    previous: null,
    policy: null,
  }))
  if (withModel)
    writeModel(root, buildModel({ vars: VARS, contracts: false, sample: false }))
  else
    rmSync(path.join(root, MODEL_FILE), { force: true })
  return root
}

function output(root: string, plain: boolean): string[] {
  const lines: string[] = []
  printDoctor(createUi(resolveTheme({ plain }), line => lines.push(line)), runDoctor(root, '0.0.0-fixture'))
  return lines
}

function occurrences(lines: string[], needle: string): number {
  return lines.filter(line => line.includes(needle)).length
}

describe('where there is no model, doctor says what writes one', () => {
  const SENTENCE = 'written by `construct init`'

  it('names init exactly once, however many sections report the absence', () => {
    const lines = output(repository(false), true)

    expect(occurrences(lines, SENTENCE)).toBe(1)
  })

  it('leaves the three existing readings of the absence word for word', () => {
    const lines = output(repository(false), true).join('\n')

    expect(lines).toContain(PLAIN_LORE.enforcementNoModel)
    expect(lines).toContain(PLAIN_LORE.hypothesesNoModel)
    expect(lines).toContain(PLAIN_LORE.youAreHereNoModel)
  })

  it('says nothing about init where a model is present', () => {
    const lines = output(repository(true), true)

    expect(occurrences(lines, SENTENCE)).toBe(0)
    expect(lines.join('\n')).not.toContain(PLAIN_LORE.enforcementNoModel)
  })

  it('carries the sentence in both vocabularies, and the plain one carries no lore', () => {
    expect(LORE.modelIsWrittenByInit).toContain(SENTENCE)
    expect(PLAIN_LORE.modelIsWrittenByInit).toContain(SENTENCE)
    expect(PLAIN_LORE.modelIsWrittenByInit).not.toMatch(/[A-Z]{4,}/)
  })

  it('states that init is additive, since the absence is not a fault to be repaired under duress', () => {
    expect(PLAIN_LORE.modelIsWrittenByInit).toContain('additive')
    expect(PLAIN_LORE.modelIsWrittenByInit).toContain('overwrites nothing it does not own')
    expect(PLAIN_LORE.modelIsWrittenByInit).toContain('Nothing forces you')
  })

  it('does not move the exit code: an absent model is still not obstruction', () => {
    const withModel = runDoctor(repository(true), '0.0.0-fixture')
    const without = runDoctor(repository(false), '0.0.0-fixture')

    expect(without?.ok).toBe(withModel?.ok)
  })
})

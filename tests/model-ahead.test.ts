import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/commands/doctor/index.js'
import { flatlineFor } from '../src/failure.js'
import { buildManifest, writeManifest } from '../src/manifest.js'
import { MODEL_FILE, MODEL_VERSION } from '../src/model/schema.js'
import { readModel } from '../src/model/write.js'
import { RecordAheadOfReader } from '../src/record-ahead.js'
import { createUi } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'

const AHEAD = MODEL_VERSION + 1

const VARS = {
  projectName: 'ahead',
  scope: '@ahead',
  nodeMajor: '24',
  contracts: 'false',
  contractPath: '',
  contractTypesOutput: '',
  compositionDir: 'architecture/composition',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '',
  reviewModel: 'claude-sonnet-5',
  constructVersion: '0.0.0-fixture',
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-model-ahead-'))
}

function repositoryWithAModelFromALaterBuild(): string {
  const dir = scratch()
  writeManifest(dir, buildManifest({
    version: '0.0.0-fixture',
    preset: 'node-backend',
    ai: 'claude',
    review: 'none',
    vars: VARS,
    written: [],
    contracts: false,
    previous: null,
    policy: null,
  }))
  writeFileSync(path.join(dir, MODEL_FILE), `${JSON.stringify({
    modelVersion: AHEAD,
    facts: [],
    claims: [],
    hypotheses: [],
    somethingThisBinaryHasNeverSeen: true,
  }, null, 2)}\n`)
  return dir
}

function repositoryWithAnInvalidModel(): string {
  const dir = repositoryWithAModelFromALaterBuild()
  writeFileSync(path.join(dir, MODEL_FILE), '{ "modelVersion": 1, "facts": "not an array" }\n')
  return dir
}

function reported(error: unknown): string {
  const lines: string[] = []
  flatlineFor(createUi(resolveTheme({ plain: true }), line => lines.push(line)), error)
  return lines.join('\n')
}

function thrownBy(run: () => unknown): unknown {
  try {
    run()
    return null
  }
  catch (error) {
    return error
  }
}

describe('a construct.model.json from a later build is a state this binary names', () => {
  it('is its own error, distinguishable from a model that is corrupt or invalid', () => {
    const ahead = thrownBy(() => readModel(repositoryWithAModelFromALaterBuild()))
    const invalid = thrownBy(() => readModel(repositoryWithAnInvalidModel()))

    expect(ahead).toBeInstanceOf(RecordAheadOfReader)
    expect(invalid).not.toBeInstanceOf(RecordAheadOfReader)
    expect(invalid).toBeInstanceOf(Error)
  })

  it('names the record it came from, because one carrier now serves the manifest and the model alike', () => {
    const error = thrownBy(() => readModel(repositoryWithAModelFromALaterBuild())) as RecordAheadOfReader

    expect(error.found).toBe(AHEAD)
    expect(error.understood).toBe(MODEL_VERSION)
    expect(error.record).toBe(MODEL_FILE)
    expect(error.field).toBe('modelVersion')
  })

  it('is reported at the composition root with both versions and no stack trace', () => {
    const line = reported(thrownBy(() => readModel(repositoryWithAModelFromALaterBuild())))

    expect(line).toContain(MODEL_FILE)
    expect(line).toContain('modelVersion')
    expect(line).toContain(String(AHEAD))
    expect(line).toContain(String(MODEL_VERSION))
    expect(line).not.toContain('    at ')
    expect(line).not.toContain('RecordAheadOfReader')
  })

  it('does not collapse into the no-model reading, so init is never offered as the way out', () => {
    const dir = repositoryWithAModelFromALaterBuild()

    expect(() => runDoctor(dir)).toThrow(RecordAheadOfReader)

    const line = reported(thrownBy(() => runDoctor(dir)))
    expect(line).not.toContain(PLAIN_LORE.modelIsWrittenByInit)
    expect(line).not.toContain('construct init')
    expect(line).not.toContain(PLAIN_LORE.enforcementNoModel)
  })
})

import type { RepositoryModel } from '../src/model/schema.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectKnowledge } from '../src/commands/doctor/index.js'
import { runInit } from '../src/commands/init.js'
import { withoutStillbornClaims } from '../src/model/birth.js'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'
import { readModel } from '../src/model/write.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const HARNESS_STEPS = 'harness-steps'
const MANIFEST = 'package.json'

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-birth-'))
}

function ui(write = silentWriter) {
  return createUi(resolveTheme({ plain: true }), write)
}

async function initialize(dir: string, write = silentWriter): Promise<void> {
  await runInit(ui(write), { dir, preset: 'node-backend', name: 'scratch', yes: true, dryRun: false })
}

function model(dir: string): RepositoryModel {
  return parseModel(readFileSync(path.join(dir, MODEL_FILE), 'utf8'), MODEL_FILE)
}

function claimIds(built: RepositoryModel): string[] {
  return built.claims.map(claim => claim.id)
}

function stateOf(dir: string, claimId: string): string | undefined {
  return projectKnowledge(readModel(dir), dir).checks.find(check => check.claimId === claimId)?.state
}

function ownerAuthoredManifest(dir: string): void {
  writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify({
    name: 'owned-by-its-author',
    scripts: {
      lint: 'eslint .',
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      quality: 'pnpm run lint && pnpm run typecheck && pnpm run test',
    },
  }, null, 2)}\n`)
}

describe('a construct claim is only written when its evidence holds on the tree init wrote', () => {
  const trees = [
    {
      name: 'the construct wrote the quality script',
      prepare: () => {},
      carriesHarnessSteps: true,
      harnessStepsReads: 'held',
    },
    {
      name: 'the owner wrote the quality script',
      prepare: ownerAuthoredManifest,
      carriesHarnessSteps: false,
      harnessStepsReads: undefined,
    },
  ] as const

  for (const tree of trees) {
    it(`carries harness-steps: ${tree.carriesHarnessSteps} when ${tree.name}`, async () => {
      const dir = scratch()
      tree.prepare(dir)
      await initialize(dir)

      expect(claimIds(model(dir)).includes(HARNESS_STEPS)).toBe(tree.carriesHarnessSteps)
      expect(stateOf(dir, HARNESS_STEPS)).toBe(tree.harnessStepsReads)
    })

    it(`reads ci as held when ${tree.name}`, async () => {
      const dir = scratch()
      tree.prepare(dir)
      await initialize(dir)

      expect(claimIds(model(dir))).toContain('every-change-passes-the-harness')
      expect(stateOf(dir, 'every-change-passes-the-harness')).toBe('held')
    })
  }

  it('drops the facts a withheld claim alone stood on, and keeps those something else stands on', async () => {
    const dir = scratch()
    ownerAuthoredManifest(dir)
    await initialize(dir)
    const built = model(dir)

    const factIds = built.facts.map(fact => fact.id)
    expect(factIds).not.toContain('harness-script-runs-lint')
    expect(factIds).not.toContain('harness-script-runs-typecheck')
    expect(factIds).not.toContain('harness-script-runs-tests')
    expect(factIds).toContain('ci-workflow-runs-the-harness')
  })

  it('names each withheld claim and the evidence that did not hold', async () => {
    const dir = scratch()
    ownerAuthoredManifest(dir)
    const lines: string[] = []
    await initialize(dir, line => lines.push(line))

    const withheld = lines.filter(line => line.includes(HARNESS_STEPS))
    expect(withheld).toHaveLength(1)
    expect(withheld[0]).toContain(MANIFEST)
  })

  it('keeps a claim already in the record and lets it read unsupported, so drift is not erased', async () => {
    const dir = scratch()
    await initialize(dir)
    expect(stateOf(dir, HARNESS_STEPS)).toBe('held')

    ownerAuthoredManifest(dir)
    await initialize(dir)

    expect(claimIds(model(dir))).toContain(HARNESS_STEPS)
    expect(stateOf(dir, HARNESS_STEPS)).toBe('unsupported')
  })

  it('withholds a claim only where evidence is unsupported, never where it is unknown', () => {
    const dir = scratch()
    const named: RepositoryModel = {
      modelVersion: MODEL_VERSION,
      facts: [{ id: 'absent-file', kind: 'file-exists', path: 'nothing/here.md', authoredBy: 'construct' }],
      claims: [
        {
          id: 'stands-on-a-fact-that-does-not-hold',
          statement: 'Its evidence is named and absent',
          authoredBy: 'construct',
          enforcement: { mechanism: 'a file that is not there', level: 'L3', supportedBy: ['absent-file'] },
          verification: null,
        },
        {
          id: 'names-no-fact-at-all',
          statement: 'Nothing was read for it',
          authoredBy: 'construct',
          enforcement: null,
          verification: null,
        },
      ],
      hypotheses: [],
    }

    const born = withoutStillbornClaims(named, null, dir)

    expect(born.stillborn.map(claim => claim.claimId)).toEqual(['stands-on-a-fact-that-does-not-hold'])
    expect(born.model.claims.map(claim => claim.id)).toEqual(['names-no-fact-at-all'])
  })
})

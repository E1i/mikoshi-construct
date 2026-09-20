import type { Claim, Fact, Hypothesis, RepositoryModel } from '../src/model/schema.js'
import type { PresetId, TemplateVars } from '../src/presets/index.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { detect } from '../src/detect/index.js'
import { planMaterialize } from '../src/materialize/plan.js'
import { selectPath } from '../src/model/path.js'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'
import { buildModel, mergeModel, writeModel } from '../src/model/write.js'
import { aiGroups, getPreset, PRESET_IDS } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

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

const AMBIGUOUS = path.resolve(import.meta.dirname, 'fixtures/model/ambiguous-path')

async function initInto(dir: string): Promise<void> {
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: 'node-backend', name: 'scratch', yes: true, dryRun: false })
}

function readModelAt(dir: string): RepositoryModel {
  return parseModel(readFileSync(path.join(dir, MODEL_FILE), 'utf8'), MODEL_FILE)
}

const DISCOVERED_FACT: Fact = { id: 'discovered-workspace-file', kind: 'file-exists', path: 'pnpm-workspace.yaml', authoredBy: 'discovery' }

const DISCOVERED_HYPOTHESIS: Hypothesis = {
  id: 'workspace-with-one-deployable',
  statement: 'This repository is a pnpm workspace whose single deployable is apps/api',
  authoredBy: 'discovery',
  baseSha: '9f1c2a0e4b7d8c6a5f3e2d1c0b9a8f7e6d5c4b3a',
  supportedBy: [DISCOVERED_FACT.id],
}

describe('a second init rewrites what the construct authored and carries the rest over', () => {
  it('leaves a hypothesis discovery wrote, and the fact it stands on, exactly as they were', async () => {
    const dir = scratch()
    await initInto(dir)
    const seeded = readModelAt(dir)
    writeModel(dir, {
      ...seeded,
      facts: [...seeded.facts, DISCOVERED_FACT],
      hypotheses: [DISCOVERED_HYPOTHESIS],
    })

    await initInto(dir)

    const again = readModelAt(dir)
    expect(again.hypotheses).toEqual([DISCOVERED_HYPOTHESIS])
    expect(again.facts).toContainEqual(DISCOVERED_FACT)
    expect(() => parseModel(readFileSync(path.join(dir, MODEL_FILE), 'utf8'), MODEL_FILE)).not.toThrow()
  })

  it('updates a construct-authored claim gone stale and drops one this preset no longer makes', async () => {
    const dir = scratch()
    await initInto(dir)
    const seeded = readModelAt(dir)
    const stale = seeded.claims[0]
    const abandonedFact: Fact = { id: 'husky-hook', kind: 'file-exists', path: '.husky/pre-commit', authoredBy: 'construct' }
    const abandoned: Claim = {
      id: 'a-claim-this-preset-no-longer-makes',
      statement: 'Every commit runs the harness through a local hook',
      authoredBy: 'construct',
      enforcement: { mechanism: '.husky/pre-commit runs the harness', level: 'L2', supportedBy: [abandonedFact.id] },
      verification: null,
    }
    writeModel(dir, {
      ...seeded,
      facts: [...seeded.facts, abandonedFact],
      claims: [{ ...stale, statement: 'a statement an earlier preset wrote' }, ...seeded.claims.slice(1), abandoned],
    })

    await initInto(dir)

    const again = readModelAt(dir)
    expect(again.claims[0]).toEqual(stale)
    expect(again.claims.map(claim => claim.id)).not.toContain(abandoned.id)
    expect(again.facts.map(fact => fact.id)).not.toContain(abandonedFact.id)
  })
})

describe('merging the model preserves the declaration order selectPath reads', () => {
  const existing = parseModel(readFileSync(path.join(AMBIGUOUS, 'construct.model.json'), 'utf8'), 'ambiguous-path')

  function stopOf(model: RepositoryModel): string | undefined {
    return selectPath(model, deriveModelState(model, path.join(AMBIGUOUS, 'tree')))?.claimId
  }

  it('keeps a surviving claim where it was declared, so the tie still breaks the same way', () => {
    const fresh: RepositoryModel = { ...existing, claims: [...existing.claims].reverse() }
    const merged = mergeModel(existing, fresh)
    expect(merged.claims.map(claim => claim.id)).toEqual(existing.claims.map(claim => claim.id))
    expect(stopOf(merged)).toBe('no-secret-reaches-a-commit')
    expect(stopOf(fresh)).toBe('imports-respect-the-dependency-policy')
  })

  it('appends an entry this run is the first to make, after everything already declared', () => {
    const newcomer: Claim = {
      id: 'dependencies-are-audited',
      statement: 'Dependencies with known high-severity vulnerabilities are visible',
      authoredBy: 'construct',
      enforcement: { mechanism: 'security.yml runs pnpm audit weekly', level: 'L3', supportedBy: ['eslint-config'] },
      verification: null,
    }
    const merged = mergeModel(existing, { ...existing, claims: [newcomer, ...existing.claims] })
    expect(merged.claims.map(claim => claim.id)).toEqual([...existing.claims.map(claim => claim.id), newcomer.id])
  })

  it('keeps a construct-authored fact the preset dropped while a carried-over entry still stands on it', () => {
    const hypothesis: Hypothesis = {
      id: 'the-hook-is-what-guards-commits',
      statement: 'The pre-commit hook is what stops a secret reaching a commit here',
      authoredBy: 'discovery',
      baseSha: null,
      supportedBy: ['commit-hook'],
    }
    const seeded: RepositoryModel = { ...existing, hypotheses: [hypothesis] }
    const fresh: RepositoryModel = {
      ...existing,
      facts: existing.facts.filter(fact => fact.id !== 'commit-hook'),
      claims: existing.claims.filter(claim => claim.id !== 'no-secret-reaches-a-commit'),
    }
    const merged = mergeModel(seeded, fresh)
    expect(merged.facts.map(fact => fact.id)).toContain('commit-hook')
    expect(merged.claims.map(claim => claim.id)).not.toContain('no-secret-reaches-a-commit')
    expect(() => parseModel(JSON.stringify(merged), 'merged')).not.toThrow()
  })

  it('is the fresh model itself when nothing is on disk yet', () => {
    expect(mergeModel(null, existing)).toBe(existing)
  })
})

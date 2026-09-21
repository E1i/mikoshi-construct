import type { Claim, Enforcement, Fact, Hypothesis, RepositoryModel } from '../src/model/schema.js'
import type { PresetId, TemplateVars } from '../src/presets/index.js'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { detect } from '../src/detect/index.js'
import { sha256 } from '../src/manifest.js'
import { planMaterialize } from '../src/materialize/plan.js'
import { selectPath } from '../src/model/path.js'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'
import { buildModel, mergeModel, writeModel } from '../src/model/write.js'
import { aiGroups, getPreset, PRESET_IDS, sampleGroups } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
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
    const model = buildModel({ vars: VARS, contracts: false, sample: false })
    expect(model).toEqual(parseModel(readFileSync(FRESH_INIT, 'utf8'), 'fresh-init'))
    expect(model.modelVersion).toBe(MODEL_VERSION)
    expect(model.hypotheses).toEqual([])
    for (const claim of model.claims) {
      expect(claim.enforcement?.supportedBy.length, claim.id).toBeGreaterThan(0)
      expect(claim.verification?.supportedBy.length, claim.id).toBeGreaterThan(0)
    }
  })

  it('takes no wall clock and no ambient read: the same input builds the same model', () => {
    expect(buildModel({ vars: VARS, contracts: false, sample: false })).toEqual(buildModel({ vars: VARS, contracts: false, sample: false }))
    expect(JSON.stringify(buildModel({ vars: { ...VARS, contractPath: 'contracts/api/openapi.yaml' }, contracts: true, sample: false }))).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('adds the contract claim only where the construct materializes a contract', () => {
    const without = buildModel({ vars: VARS, contracts: false, sample: false })
    const with_ = buildModel({ vars: { ...VARS, contractPath: 'contracts/api/openapi.yaml' }, contracts: true, sample: false })
    expect(without.claims.map(claim => claim.id)).not.toContain('a-breaking-api-change-is-named-before-it-ships')
    expect(with_.claims.map(claim => claim.id)).toContain('a-breaking-api-change-is-named-before-it-ships')
    expect(with_.facts.some(fact => fact.path === 'contracts/api/openapi.yaml')).toBe(true)
  })

  for (const presetId of PRESET_IDS) {
    it(`${presetId}: grounds every fact in a file that preset really materializes`, () => {
      const preset = getPreset(presetId)
      const content = materializedContent(presetId)
      const dir = scratch()
      const model = buildModel({ vars: presetVars(dir, presetId), contracts: preset.contracts, sample: sampleGroups(preset).length > 0 })
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
    const model = buildModel({ vars: VARS, contracts: false, sample: false })
    writeModel(dir, model)
    const source = readFileSync(path.join(dir, MODEL_FILE), 'utf8')
    expect(source).toBe(`${JSON.stringify(model, null, 2)}\n`)
    expect(parseModel(source, MODEL_FILE)).toEqual(model)
  })

  it('is the model this repository commits, built from its own manifest rather than by hand', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'construct.json'), 'utf8')) as { preset: PresetId, vars: TemplateVars, contracts: unknown }
    const committed = readFileSync(path.join(REPO_ROOT, MODEL_FILE), 'utf8')
    const model = buildModel({ vars: manifest.vars, contracts: manifest.contracts != null, sample: sampleGroups(getPreset(manifest.preset)).length > 0 })
    expect(parseModel(committed, MODEL_FILE)).toEqual(model)
    expect(committed).toBe(`${JSON.stringify(model, null, 2)}\n`)
  })
})

const AMBIGUOUS = path.resolve(import.meta.dirname, 'fixtures/model/ambiguous-path')

async function initInto(dir: string, write = silentWriter): Promise<string> {
  const result = await runInit(createUi(resolveTheme({ plain: true }), write), { dir, preset: 'node-backend', name: 'scratch', yes: true, dryRun: false })
  return result.status
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
  evidenceClean: true,
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
    expect(again.hypotheses[0].baseSha).toBe(DISCOVERED_HYPOTHESIS.baseSha)
    expect(again.hypotheses[0].evidenceClean).toBe(DISCOVERED_HYPOTHESIS.evidenceClean)
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
    const merged = mergeModel(existing, fresh).model
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
    const merged = mergeModel(existing, { ...existing, claims: [newcomer, ...existing.claims] }).model
    expect(merged.claims.map(claim => claim.id)).toEqual([...existing.claims.map(claim => claim.id), newcomer.id])
  })

  it('keeps a construct-authored fact the preset dropped while a carried-over entry still stands on it', () => {
    const hypothesis: Hypothesis = {
      id: 'the-hook-is-what-guards-commits',
      statement: 'The pre-commit hook is what stops a secret reaching a commit here',
      authoredBy: 'discovery',
      baseSha: null,
      evidenceClean: false,
      supportedBy: ['commit-hook'],
    }
    const seeded: RepositoryModel = { ...existing, hypotheses: [hypothesis] }
    const fresh: RepositoryModel = {
      ...existing,
      facts: existing.facts.filter(fact => fact.id !== 'commit-hook'),
      claims: existing.claims.filter(claim => claim.id !== 'no-secret-reaches-a-commit'),
    }
    const merged = mergeModel(seeded, fresh).model
    expect(merged.facts.map(fact => fact.id)).toContain('commit-hook')
    expect(merged.claims.map(claim => claim.id)).not.toContain('no-secret-reaches-a-commit')
    expect(() => parseModel(JSON.stringify(merged), 'merged')).not.toThrow()
  })

  it('is the fresh model itself when nothing is on disk yet', () => {
    expect(mergeModel(null, existing).model).toBe(existing)
  })
})

const ABANDONED_FACTS: Fact[] = [
  { id: 'abandoned-hook', kind: 'file-exists', path: '.husky/pre-commit', authoredBy: 'construct' },
  { id: 'abandoned-hook-runs-the-harness', kind: 'file-contains', path: '.husky/pre-commit', authoredBy: 'construct', needle: 'pnpm run quality' },
  { id: 'abandoned-hook-documented', kind: 'file-exists', path: 'docs/hooks.md', authoredBy: 'construct' },
]

const STOOD_ON_BY_A_HYPOTHESIS: Hypothesis = {
  id: 'the-hook-is-what-guards-commits',
  statement: 'A local hook is what runs the harness before a commit here',
  authoredBy: 'discovery',
  baseSha: null,
  evidenceClean: false,
  supportedBy: ['abandoned-hook'],
}

const STOOD_ON_BY_A_CLAIM: Claim = {
  id: 'the-harness-runs-before-a-commit',
  statement: 'The harness runs before a commit lands, not only in CI',
  authoredBy: 'unknown',
  enforcement: { mechanism: '.husky/pre-commit runs the harness', level: 'L2', supportedBy: ['abandoned-hook-runs-the-harness'] },
  verification: { mechanism: 'docs/hooks.md names the hook that does it', supportedBy: ['abandoned-hook-documented'] },
}

async function seedAndReinit(dir: string, seed: (model: RepositoryModel) => RepositoryModel): Promise<RepositoryModel> {
  await initInto(dir)
  const base = readModelAt(dir)
  writeModel(dir, seed({ ...base, facts: [...base.facts, ...ABANDONED_FACTS] }))
  expect(await initInto(dir)).toBe('done')
  expect(await initInto(dir)).toBe('done')
  return readModelAt(dir)
}

describe('every entry the model keeps still stands on a fact the model declares', () => {
  it('keeps the fact a discovery-authored hypothesis stands on, so the next init can read what this one wrote', async () => {
    const dir = scratch()
    const model = await seedAndReinit(dir, base => ({ ...base, hypotheses: [STOOD_ON_BY_A_HYPOTHESIS] }))

    expect(model.hypotheses).toEqual([STOOD_ON_BY_A_HYPOTHESIS])
    expect(model.facts).toContainEqual(ABANDONED_FACTS[0])
    expect(model.facts.map(fact => fact.id)).not.toContain('abandoned-hook-documented')
  })

  it('keeps both facts a claim the construct does not own stands on, one through enforcement and one through verification', async () => {
    const dir = scratch()
    const model = await seedAndReinit(dir, base => ({ ...base, claims: [...base.claims, STOOD_ON_BY_A_CLAIM] }))

    expect(model.claims).toContainEqual(STOOD_ON_BY_A_CLAIM)
    expect(model.facts).toContainEqual(ABANDONED_FACTS[1])
    expect(model.facts).toContainEqual(ABANDONED_FACTS[2])
    expect(model.facts.map(fact => fact.id)).not.toContain('abandoned-hook')
  })
})

describe('the model is checked against its own schema before it is committed', () => {
  it('refuses to write a merge result that would not parse, and leaves no file behind', () => {
    const dir = scratch()
    const fresh = buildModel({ vars: VARS, contracts: false, sample: false })
    const stoodOn: RepositoryModel = { ...fresh, hypotheses: [STOOD_ON_BY_A_HYPOTHESIS] }
    const { model } = mergeModel({ ...stoodOn, facts: [...fresh.facts, ABANDONED_FACTS[0]] }, fresh)
    const withoutRetention: RepositoryModel = { ...model, facts: model.facts.filter(fact => fact.id !== 'abandoned-hook') }

    expect(() => writeModel(dir, withoutRetention)).toThrow('abandoned-hook')
    expect(existsSync(path.join(dir, MODEL_FILE))).toBe(false)
  })
})

describe('a model naming a fact it does not carry stops the run before anything is written', () => {
  const dangling = {
    modelVersion: MODEL_VERSION,
    facts: [],
    claims: [],
    hypotheses: [{ ...STOOD_ON_BY_A_HYPOTHESIS, supportedBy: ['a-fact-somebody-deleted'] }],
  }

  it('raises the dangling-reference error in a directory carrying nothing but the model, and leaves that model as it was', async () => {
    const dir = scratch()
    const source = `${JSON.stringify(dangling, null, 2)}\n`
    writeFileSync(path.join(dir, MODEL_FILE), source)

    await expect(initInto(dir)).rejects.toThrow(/construct\.model\.json[\s\S]*a-fact-somebody-deleted[\s\S]*not replaced/)

    expect(readdirSync(dir)).toEqual([MODEL_FILE])
    expect(readFileSync(path.join(dir, MODEL_FILE), 'utf8')).toBe(source)
  })
})

const PROBE_FILE = '.gitleaks.toml'

function treeHashes(dir: string): Record<string, string> {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .filter(file => file !== MODEL_FILE)
    .sort()
  return Object.fromEntries(files.map(file => [file, sha256(readFileSync(path.join(dir, file), 'utf8'))]))
}

function breakSupportedBy(dir: string, factId: string): string {
  const model = JSON.parse(readFileSync(path.join(dir, MODEL_FILE), 'utf8')) as RepositoryModel
  const enforcement = model.claims[0].enforcement as Enforcement
  enforcement.supportedBy = [factId]
  const source = `${JSON.stringify(model, null, 2)}\n`
  writeFileSync(path.join(dir, MODEL_FILE), source)
  return source
}

async function messageOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
  }
  catch (error) {
    return (error as Error).message
  }
  return ''
}

describe('a malformed model changes nothing in a repository the construct has already materialized', () => {
  it('leaves every file byte for byte as it was, and does not bring back a file deleted before the run', async () => {
    const dir = scratch()
    expect(await initInto(dir)).toBe('done')
    const broken = breakSupportedBy(dir, 'a-fact-somebody-deleted')
    rmSync(path.join(dir, PROBE_FILE))
    const before = treeHashes(dir)
    expect(Object.keys(before)).toContain('.github/workflows/ci.yml')
    expect(Object.keys(before)).not.toContain(MODEL_FILE)
    expect(Object.keys(before).length).toBeGreaterThan(10)

    const message = await messageOf(initInto(dir))

    expect(message).toContain(MODEL_FILE)
    expect(message).toContain('claims[0].enforcement')
    expect(message).toContain('a-fact-somebody-deleted')
    expect(message).toContain('not replaced')
    expect(message).toContain('put the fact "a-fact-somebody-deleted" back')
    expect(message).toContain('drop it from claims[0].enforcement')
    expect(existsSync(path.join(dir, PROBE_FILE))).toBe(false)
    expect(treeHashes(dir)).toEqual(before)
    expect(readFileSync(path.join(dir, MODEL_FILE), 'utf8')).toBe(broken)
  })

  it('would have brought that file back had the model parsed, so its absence is the run stopping and not a file the construct never writes', async () => {
    const dir = scratch()
    expect(await initInto(dir)).toBe('done')
    rmSync(path.join(dir, PROBE_FILE))

    expect(await initInto(dir)).toBe('done')

    expect(existsSync(path.join(dir, PROBE_FILE))).toBe(true)
  })
})

describe('a second init says which facts it kept for an entry it does not own', () => {
  it('names how many facts were retained and the entry standing on them, and stays quiet when none were', async () => {
    const dir = scratch()
    const spoken: string[] = []
    await initInto(dir)
    const base = readModelAt(dir)
    writeModel(dir, { ...base, facts: [...base.facts, ABANDONED_FACTS[0]], hypotheses: [STOOD_ON_BY_A_HYPOTHESIS] })

    await initInto(dir, text => spoken.push(text))
    const line = spoken.join('').split('\n').find(text => text.includes(STOOD_ON_BY_A_HYPOTHESIS.id))
    expect(line).toBeDefined()
    expect(line).toContain(PLAIN_LORE.recordFactsRetained(['abandoned-hook'], [STOOD_ON_BY_A_HYPOTHESIS.id]))

    const untouched = scratch()
    const quiet: string[] = []
    await initInto(untouched)
    await initInto(untouched, text => quiet.push(text))
    expect(quiet.join('').toLowerCase()).not.toContain('kept 0')
    expect(quiet.join('')).not.toContain('still stands on')
  })
})

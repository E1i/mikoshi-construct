import type { Manifest } from '../src/manifest.js'
import type { FileOp } from '../src/materialize/plan.js'
import type { AiTarget, PresetId, TemplateVars } from '../src/presets/index.js'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { detect } from '../src/detect/index.js'
import { buildManifest, MANIFEST_FILE, readManifest, sha256, writeManifest } from '../src/manifest.js'
import { applyPlan } from '../src/materialize/apply.js'
import { planMaterialize } from '../src/materialize/plan.js'
import { aiGroups, getPreset, PRESET_IDS } from '../src/presets/index.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const DRIFT_FILE = 'architecture/self-hosting-drift.yaml'
const AI_TARGETS: AiTarget[] = ['claude', 'cursor', 'both']

const PINNED_VARS: TemplateVars = {
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
  return mkdtempSync(path.join(tmpdir(), 'construct-reproduce-'))
}

function materialize(dir: string, presetId: PresetId, ai: AiTarget, vars: TemplateVars): FileOp[] {
  const preset = getPreset(presetId)
  const report = detect(dir)
  const plan = planMaterialize(dir, [...preset.groups, ...aiGroups(ai)], vars, { emptyTarget: report.layout === 'empty', ai })
  return applyPlan(dir, plan.ops)
}

function presetVars(dir: string, presetId: PresetId): TemplateVars {
  const preset = getPreset(presetId)
  return {
    ...PINNED_VARS,
    contracts: preset.contracts ? 'true' : 'false',
    ...preset.vars(detect(dir), PINNED_VARS.projectName),
  }
}

function runPinnedInit(presetId: PresetId, ai: AiTarget): string {
  const dir = scratch()
  const vars = presetVars(dir, presetId)
  const written = materialize(dir, presetId, ai, vars)
  writeManifest(dir, buildManifest({ version: PINNED_VARS.constructVersion, preset: presetId, ai, review: 'none', vars, written, contracts: getPreset(presetId).contracts, previous: null }))
  return dir
}

function treeHashes(dir: string): Record<string, string> {
  const files = (readdirSync(dir, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .filter(file => file !== MANIFEST_FILE)
    .sort()
  return Object.fromEntries(files.map(file => [file, sha256(readFileSync(path.join(dir, file), 'utf8'))]))
}

function withoutWallClock(manifest: Manifest | null): Omit<Manifest, 'createdAt'> {
  const { createdAt, ...rest } = manifest as Manifest
  expect(Date.parse(createdAt)).not.toBeNaN()
  return rest
}

describe('materialization is deterministic', () => {
  for (const presetId of PRESET_IDS) {
    for (const ai of AI_TARGETS) {
      it(`${presetId} + ${ai}: two runs with the same pinned variables write byte-identical trees`, () => {
        const first = runPinnedInit(presetId, ai)
        const second = runPinnedInit(presetId, ai)

        const left = treeHashes(first)
        const right = treeHashes(second)
        expect(Object.keys(left).length).toBeGreaterThan(0)
        expect(Object.keys(right)).toEqual(Object.keys(left))
        expect(right).toEqual(left)
      })
    }
  }

  it('measures the generator, not the machine: every environment-derived variable is pinned, never read from the ambient host', () => {
    const dir = scratch()
    const vars = presetVars(dir, 'monorepo')
    const ambient = detect(dir)
    expect(vars.nodeMajor).toBe('22')
    expect(vars.pnpmVersion).toBe('12.4.2')
    expect(vars.compositionDir).toBe('architecture/composition')
    expect(vars.projectName).toBe('pinned-fixture')
    expect(vars.projectName).not.toBe(path.basename(ambient.dir))
  })

  it('excludes construct.json from the comparison because buildManifest stamps createdAt with the wall clock; everything else in it is identical', () => {
    const first = runPinnedInit('node-library', 'claude')
    const second = runPinnedInit('node-library', 'claude')
    expect(withoutWallClock(readManifest(second))).toEqual(withoutWallClock(readManifest(first)))
  })
})

type DriftKind = 'content' | 'skipped-at-init' | 'absent-at-root'

interface DriftEntry {
  path: string
  kind: DriftKind
  reason: string
}

interface DriftList {
  replay: { preset: PresetId, ai: AiTarget, projectName: string, vars: string }
  differences: DriftEntry[]
}

const DRIFT_KINDS: DriftKind[] = ['content', 'skipped-at-init', 'absent-at-root']

function driftList(): DriftList {
  return parse(readFileSync(path.join(REPO_ROOT, DRIFT_FILE), 'utf8')) as DriftList
}

function replayAgainstRepository(manifest: Manifest): { path: string, kind: DriftKind }[] {
  const dir = scratch()
  const written = materialize(dir, manifest.preset, manifest.ai, manifest.vars as TemplateVars)
  const differences: { path: string, kind: DriftKind }[] = []
  for (const op of written) {
    const at = path.join(REPO_ROOT, op.target)
    if (!existsSync(at)) {
      differences.push({ path: op.target, kind: 'absent-at-root' })
      continue
    }
    if (readFileSync(at, 'utf8') === op.content)
      continue
    differences.push({ path: op.target, kind: manifest.files[op.target] == null ? 'skipped-at-init' : 'content' })
  }
  return differences.sort((a, b) => a.path.localeCompare(b.path))
}

describe('self-hosting: this repository replays its own materialization', () => {
  it('reproduces materialization only — discovery is prose a repository writes once and never writes the same way twice, so its contribution is covered by provenance, not by comparing text', () => {
    const manifest = readManifest(REPO_ROOT)
    expect(manifest?.preset).toBe('node-library')
    expect(manifest?.ai).toBe('claude')
    expect(manifest?.vars.projectName).toBe('mikoshi-construct')
    const list = driftList()
    expect(list.replay).toEqual({ preset: manifest?.preset, ai: manifest?.ai, projectName: manifest?.vars.projectName, vars: MANIFEST_FILE })
    const discoveryFiles = [...new Set(Object.values(manifest?.discovery.markers ?? {}).map(provenance => provenance.file))].filter(file => file.endsWith('.md'))
    for (const file of discoveryFiles)
      expect(list.differences.some(entry => entry.path === file), `${file} carries discovery and cannot be reproduced`).toBe(true)
  })

  it('leaves no difference against the repository root undeclared, and no declared difference that has stopped differing', () => {
    const manifest = readManifest(REPO_ROOT) as Manifest
    const differences = replayAgainstRepository(manifest)
    const declared = driftList().differences

    for (const entry of declared) {
      expect(DRIFT_KINDS, entry.path).toContain(entry.kind)
      expect(entry.reason?.length ?? 0, entry.path).toBeGreaterThan(20)
    }

    const declaredPaths = declared.map(entry => entry.path)
    const undeclared = differences.filter(difference => !declaredPaths.includes(difference.path)).map(difference => difference.path)
    const identical = declaredPaths.filter(file => !differences.some(difference => difference.path === file))
    expect(undeclared, 'differs from the replay but is not declared in the drift list').toEqual([])
    expect(identical, 'declared in the drift list but no longer differs from the replay').toEqual([])
    expect(differences).toEqual(declared.map(entry => ({ path: entry.path, kind: entry.kind })).sort((a, b) => a.path.localeCompare(b.path)))
  })
})

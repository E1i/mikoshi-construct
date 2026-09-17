import type { TemplateVars } from '../src/presets/index.js'
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/commands/doctor/index.js'
import { buildManifest, DISCOVERY_MARKERS, MANIFEST_VERSION, readManifest, upgradeManifest, writeManifest } from '../src/manifest.js'

const LEGACY_FIXTURE = path.join(import.meta.dirname, 'fixtures/manifest/legacy-0.1.x')

const VARS: TemplateVars = {
  projectName: 'fixture',
  scope: '@fixture',
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

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-manifest-'))
}

function currentManifest() {
  return buildManifest({ version: VARS.constructVersion, preset: 'node-backend', ai: 'claude', review: 'none', vars: VARS, written: [], contracts: false })
}

function legacyRoot(): string {
  const root = scratch()
  cpSync(LEGACY_FIXTURE, root, { recursive: true })
  return root
}

describe('the manifest records where each discovery marker came from', () => {
  it('carries a schema version of its own, separate from the CLI version that wrote it', () => {
    const manifest = currentManifest()
    expect(manifest.manifestVersion).toBe(MANIFEST_VERSION)
    expect(manifest.manifestVersion).not.toBe(manifest.construct)
  })

  it('claims nothing at init: every marker names its file, and no marker is authored until discovery runs', () => {
    const manifest = currentManifest()
    expect(manifest.discovery.baseSha).toBeNull()
    expect(manifest.discovery.filledAt).toBeNull()
    expect(Object.keys(manifest.discovery.markers)).toEqual([...DISCOVERY_MARKERS])
    for (const marker of DISCOVERY_MARKERS) {
      expect(manifest.discovery.markers[marker].file).not.toBe('')
      expect(manifest.discovery.markers[marker].authoredBy).toBe('unknown')
      expect(manifest.discovery.markers[marker].sha).toBeNull()
    }
  })
})

describe('a manifest written by 0.1.x still reads', () => {
  it('normalises the flat discovery map into a marker record, keeping the file each marker names', () => {
    const manifest = readManifest(legacyRoot())
    expect(manifest?.discovery.markers.composition.file).toBe('docs/architecture/composition')
    expect(manifest?.discovery.markers.product.file).toBe('AGENTS.md')
    expect(manifest?.discovery.baseSha).toBeNull()
    expect(manifest?.discovery.filledAt).toBeNull()
    expect(manifest?.manifestVersion).toBe(MANIFEST_VERSION)
    expect(manifest?.construct).toBe('0.1.0')
  })

  it('reads every legacy marker as unknown, never as construct: a manifest with no provenance is no evidence that the tool wrote the prose', () => {
    const manifest = readManifest(legacyRoot())
    for (const marker of DISCOVERY_MARKERS)
      expect(manifest?.discovery.markers[marker].authoredBy).toBe('unknown')
  })

  it('lets doctor run on a repository initialised before provenance existed, instead of joining a path with an object', () => {
    const root = legacyRoot()
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'legacy', scripts: { quality: 'pnpm lint && pnpm typecheck && pnpm test' } }))
    const result = runDoctor(root)
    expect(result).not.toBeNull()
    expect(result?.provenance.map(reading => reading.authorship)).toEqual(DISCOVERY_MARKERS.map(() => 'unknown'))
  })

  it('leaves a manifest that already carries provenance untouched', () => {
    const root = scratch()
    const manifest = currentManifest()
    manifest.discovery = {
      baseSha: 'c0ffee',
      filledAt: '2026-09-17T00:00:00.000Z',
      markers: { ...manifest.discovery.markers, product: { file: 'AGENTS.md', authoredBy: 'construct', sha: 'abc123' } },
    }
    writeManifest(root, manifest)
    expect(readManifest(root)).toEqual(manifest)
    expect(upgradeManifest(manifest)).toEqual(manifest)
  })
})

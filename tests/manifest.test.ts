import type { TemplateVars } from '../src/presets/index.js'
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/commands/doctor/index.js'
import { buildManifest, DISCOVERY_MARKERS, MANIFEST_VERSION, readManifest, recordedShas, recordSync, upgradeManifest, writeManifest } from '../src/manifest.js'

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
  return buildManifest({ version: VARS.constructVersion, preset: 'node-backend', ai: 'claude', review: 'none', vars: VARS, written: [], contracts: false, previous: null })
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

describe('the manifest records what sync wrote, beside what init wrote', () => {
  function syncedManifest() {
    const manifest = currentManifest()
    manifest.files = { 'AGENTS.md': 'init-sha-of-agents', 'architecture/principles.md': 'init-sha-of-principles' }
    manifest.sync = {
      ranAt: '2026-09-17T10:00:00.000Z',
      fromVersion: '0.1.0',
      toVersion: VARS.constructVersion,
      files: { 'AGENTS.md': 'sync-sha-of-agents' },
      variants: { 'AGENTS.md': 'existing' },
    }
    return manifest
  }

  it('leaves the frozen init branch alone and adds a branch of its own', () => {
    const manifest = currentManifest()
    expect(manifest.sync).toBeNull()
    expect(manifest.files).toEqual({})
    expect(manifest.construct).toBe(VARS.constructVersion)
  })

  it('reads the recorded sha from the sync branch when it has one, and from the init branch otherwise', () => {
    const root = scratch()
    writeManifest(root, syncedManifest())
    const manifest = readManifest(root)

    expect(manifest?.sync?.fromVersion).toBe('0.1.0')
    expect(manifest?.sync?.toVersion).toBe(VARS.constructVersion)
    expect(manifest?.sync?.ranAt).toBe('2026-09-17T10:00:00.000Z')
    expect(recordedShas(manifest!)).toEqual({
      'AGENTS.md': 'sync-sha-of-agents',
      'architecture/principles.md': 'init-sha-of-principles',
    })
    expect(recordedShas(manifest!)['AGENTS.md']).not.toBe(manifest?.files['AGENTS.md'])
  })

  it('normalises both earlier shapes: a 0.1.x manifest and one written before sync existed carry no sync record', () => {
    expect(readManifest(legacyRoot())?.sync).toBeNull()
    expect(upgradeManifest({ ...currentManifest(), sync: undefined }).sync).toBeNull()
    expect(upgradeManifest({ ...currentManifest(), sync: { files: { 'AGENTS.md': 'sha' } } }).sync).toBeNull()
    expect(upgradeManifest(syncedManifest()).manifestVersion).toBe(MANIFEST_VERSION)
    expect(upgradeManifest(syncedManifest()).sync?.files).toEqual({ 'AGENTS.md': 'sync-sha-of-agents' })
  })
})

describe('recording a sync run in the manifest', () => {
  const RAN_AT = '2026-09-17T12:00:00.000Z'

  it('writes the run and the owned sha of each path into the sync branch, and nothing else', () => {
    const before = currentManifest()
    before.construct = '0.1.0'
    const after = recordSync(before, { ranAt: RAN_AT, toVersion: VARS.constructVersion, files: { 'AGENTS.md': 'owned-sha' }, variants: { 'AGENTS.md': 'existing' } })

    expect(after.sync).toEqual({ ranAt: RAN_AT, fromVersion: '0.1.0', toVersion: VARS.constructVersion, files: { 'AGENTS.md': 'owned-sha' }, variants: { 'AGENTS.md': 'existing' } })
    expect({ ...after, sync: null }).toEqual({ ...before, sync: null })
    expect(before.sync).toBeNull()
  })

  it('accumulates, so a later run never drops what an earlier one recorded', () => {
    const first = recordSync(currentManifest(), { ranAt: RAN_AT, toVersion: VARS.constructVersion, files: { 'AGENTS.md': 'first' } })
    const second = recordSync(first, { ranAt: '2026-09-18T12:00:00.000Z', toVersion: VARS.constructVersion, files: { 'CLAUDE.md': 'second' } })

    expect(second.sync?.files).toEqual({ 'AGENTS.md': 'first', 'CLAUDE.md': 'second' })
    expect(second.sync?.ranAt).toBe('2026-09-18T12:00:00.000Z')
    expect(recordSync(second, { ranAt: RAN_AT, toVersion: VARS.constructVersion, files: { 'AGENTS.md': 'rewritten' } }).sync?.files['AGENTS.md']).toBe('rewritten')
  })
})

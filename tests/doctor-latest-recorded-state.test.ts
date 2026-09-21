import type { TemplateVars } from '../src/presets/index.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/commands/doctor/index.js'
import { buildManifest, recordSync, sha256, writeManifest } from '../src/manifest.js'

const VARS: TemplateVars = {
  projectName: 'synced-fixture',
  scope: '@synced-fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: '',
  contractTypesOutput: '',
  compositionDir: 'architecture/composition',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: '',
  constructVersion: '0.1.1',
}

const MATERIALIZED = '{ "scripts": { "quality": "pnpm lint && pnpm typecheck && pnpm test" } }'
const SYNCED = '{ "scripts": { "quality": "pnpm lint && pnpm typecheck && pnpm test", "ci": "pnpm run quality" } }'

function syncedRepository(onDisk: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-synced-'))
  writeFileSync(path.join(root, 'package.json'), onDisk)
  const materialized = buildManifest({
    version: '0.1.1',
    preset: 'node-backend',
    ai: 'claude',
    review: 'none',
    vars: VARS,
    written: [{ target: 'package.json', strategy: 'create', action: 'create', content: MATERIALIZED }],
    contracts: false,
    previous: null,
  })
  writeManifest(root, recordSync(materialized, {
    ranAt: '2026-09-21T00:00:00.000Z',
    toVersion: '0.5.0',
    files: { 'package.json': sha256(SYNCED) },
  }))
  return root
}

describe('the baseline a path is compared against is its latest recorded state', () => {
  it('does not call a file modified when it matches what sync recorded, though the frozen init record is older', () => {
    const verdict = runDoctor(syncedRepository(SYNCED))
    expect(verdict?.modifiedFiles).toEqual([])
    expect(verdict?.missingFiles).toEqual([])
  })

  it('still calls a file modified when it matches neither record, so the fix does not become reporting nothing', () => {
    const verdict = runDoctor(syncedRepository(`${SYNCED}\n`))
    expect(verdict?.modifiedFiles).toEqual(['package.json'])
  })
})

const SYNC_ONLY = 'architecture/decisions/README.md'
const ARRIVED_WITH_SYNC = '# Decisions\n'

function withAPathOnlySyncRecorded(onDisk: string | null): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-sync-only-'))
  writeFileSync(path.join(root, 'package.json'), MATERIALIZED)
  mkdirSync(path.join(root, path.dirname(SYNC_ONLY)), { recursive: true })
  writeFileSync(path.join(root, SYNC_ONLY), ARRIVED_WITH_SYNC)
  const materialized = buildManifest({
    version: '0.1.1',
    preset: 'node-backend',
    ai: 'claude',
    review: 'none',
    vars: VARS,
    written: [{ target: 'package.json', strategy: 'create', action: 'create', content: MATERIALIZED }],
    contracts: false,
    previous: null,
  })
  writeManifest(root, recordSync(materialized, {
    ranAt: '2026-09-21T00:00:00.000Z',
    toVersion: '0.5.0',
    files: { [SYNC_ONLY]: sha256(ARRIVED_WITH_SYNC) },
  }))
  if (onDisk == null)
    rmSync(path.join(root, SYNC_ONLY))
  else
    writeFileSync(path.join(root, SYNC_ONLY), onDisk)
  return root
}

describe('a path only the sync record names is examined like any other', () => {
  it('says nothing about it while it matches what sync recorded', () => {
    const verdict = runDoctor(withAPathOnlySyncRecorded(ARRIVED_WITH_SYNC))
    expect(verdict?.missingFiles).toEqual([])
    expect(verdict?.modifiedFiles).toEqual([])
  })

  it('reports it missing when it is gone, rather than never looking at a path the init record never held', () => {
    expect(runDoctor(withAPathOnlySyncRecorded(null))?.missingFiles).toEqual([SYNC_ONLY])
  })

  it('reports it modified when it was edited, so the silent half is held and not merely repaired', () => {
    expect(runDoctor(withAPathOnlySyncRecorded(`${ARRIVED_WITH_SYNC}edited\n`))?.modifiedFiles).toEqual([SYNC_ONLY])
  })
})

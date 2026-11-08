import type { ClientRecord } from '../src/manifest.js'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { applySync } from '../src/commands/sync/index.js'
import { clientIdFor, clientModelOf, MANIFEST_FILE, MANIFEST_VERSION, readManifest, upgradeManifest } from '../src/manifest.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const FROZEN_RECORD = path.join(import.meta.dirname, 'fixtures/sync/materialized-by-0.1.0/construct.json')
const RECORD: ClientRecord = { id: 'adapter-a', model: 'some-model', roles: { launch: 'adapter-a', answer: 'adapter-a', review: 'adapter-b', window: 'adapter-a' } }

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-client-'))
}

function rawRecord(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')) as Record<string, unknown>
}

function withClient(dir: string, client: unknown): void {
  writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify({ ...rawRecord(dir), client }, null, 2)}\n`)
}

async function init(dir: string): Promise<void> {
  await runInit(ui, { dir, preset: 'node-backend', name: 'scratch', yes: true, dryRun: false })
}

describe('the client branch of construct.json', () => {
  it('no record writes no branch, and manifestVersion does not move', async () => {
    const dir = scratch()
    await init(dir)
    expect(rawRecord(dir)).not.toHaveProperty('client')
    expect(rawRecord(dir).manifestVersion).toBe(MANIFEST_VERSION)
    expect(MANIFEST_VERSION).toBe(6)
  })

  it('sync leaves the branch as it found it', () => {
    const dir = scratch()
    cpSync(FROZEN_RECORD, path.join(dir, MANIFEST_FILE))
    withClient(dir, RECORD)
    const result = applySync(dir, VERSION)!
    expect(result.written.length).toBeGreaterThan(0)
    expect(rawRecord(dir).sync).not.toBeNull()
    expect(rawRecord(dir).client).toEqual(RECORD)
  })

  it('a repeated init keeps the branch from the previous record', async () => {
    const dir = scratch()
    await init(dir)
    withClient(dir, RECORD)
    await init(dir)
    expect(rawRecord(dir).client).toEqual(RECORD)
  })

  it('reads every key as optional and drops what is not text', () => {
    const base = JSON.parse(readFileSync(FROZEN_RECORD, 'utf8')) as Record<string, unknown>
    expect(upgradeManifest(base).client).toBeUndefined()
    expect(upgradeManifest({ ...base, client: {} }).client).toEqual({})
    expect(upgradeManifest({ ...base, client: { id: 7, model: ' ', roles: { review: 'adapter-b', ladder: 'adapter-b', answer: 1 } } }).client).toEqual({ roles: { review: 'adapter-b' } })
    expect(upgradeManifest({ ...base, client: 'adapter-a' }).client).toBeUndefined()
  })

  it('a role names its client over the record id, and no record names none', () => {
    expect(clientIdFor(undefined, 'launch')).toBeNull()
    expect(clientIdFor({ id: 'adapter-a' }, 'launch')).toBe('adapter-a')
    expect(clientIdFor(RECORD, 'review')).toBe('adapter-b')
    expect(clientModelOf(undefined)).toBe('auto')
    expect(clientModelOf(RECORD)).toBe('some-model')
  })

  it('reads a record with the branch back from disk', async () => {
    const dir = scratch()
    await init(dir)
    withClient(dir, RECORD)
    expect(readManifest(dir)!.client).toEqual(RECORD)
  })
})

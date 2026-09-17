import type { Manifest } from '../src/manifest.js'
import type { PathClassification } from '../src/sync/classify.js'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { applySync, runSync } from '../src/commands/sync/index.js'
import { readManifest, upgradeManifest, writeManifest } from '../src/manifest.js'
import { strategyFor } from '../src/materialize/strategies.js'
import { isWritable } from '../src/sync/classify.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)

const FIXTURE = path.join(import.meta.dirname, 'fixtures/sync/materialized-by-0.1.0')
const BLOCK_TARGETS = ['AGENTS.md', 'CLAUDE.md']

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-variant-'))
}

async function materialized(dir: string): Promise<Manifest> {
  await runInit(ui, { dir, preset: 'node-backend', name: 'scratch', yes: true, dryRun: false })
  return readManifest(dir)!
}

function withoutTheVariantRecord(dir: string): Manifest {
  const manifest = readManifest(dir)!
  writeManifest(dir, { ...manifest, variants: {} })
  return readManifest(dir)!
}

function at(dir: string, target: string): PathClassification | undefined {
  return runSync(dir, VERSION)!.classifications.find(entry => entry.target === target)
}

function frozenTree(): string {
  const dir = scratch()
  cpSync(path.join(FIXTURE, 'construct.json'), path.join(dir, 'construct.json'))
  cpSync(path.join(FIXTURE, 'AGENTS.md.frozen'), path.join(dir, 'AGENTS.md'))
  cpSync(path.join(FIXTURE, 'CLAUDE.md.frozen'), path.join(dir, 'CLAUDE.md'))
  mkdirSync(path.join(dir, 'architecture'), { recursive: true })
  cpSync(path.join(FIXTURE, 'security-invariants.md.frozen'), path.join(dir, 'architecture/security-invariants.md'))
  return dir
}

describe('init records the template variant it used', () => {
  it('names a variant for every append-block target it wrote, and for nothing else', async () => {
    const dir = scratch()
    const manifest = await materialized(dir)

    for (const target of BLOCK_TARGETS)
      expect(manifest.variants[target], target).toBe('default')
    expect(Object.keys(manifest.variants).every(target => strategyFor(target) === 'append-block')).toBe(true)
    for (const target of Object.keys(manifest.files).filter(target => strategyFor(target) === 'append-block'))
      expect(manifest.variants[target], target).toBeDefined()
  })

  it('records the existing variant for a file the repository already carried', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mine\n')
    const manifest = await materialized(dir)

    expect(manifest.variants['CLAUDE.md']).toBe('existing')
    expect(manifest.variants['AGENTS.md']).toBe('default')
  })

  it('gives a manifest written before this change no variant record at all', () => {
    const frozen = upgradeManifest(JSON.parse(readFileSync(path.join(FIXTURE, 'construct.json'), 'utf8')))
    expect(frozen.variants).toEqual({})
    for (const target of BLOCK_TARGETS)
      expect(frozen.variants[target], target).toBeUndefined()
  })
})

describe('the variant is taken from the record, and otherwise proven by reconstruction', () => {
  it('takes the record when there is one, without rendering anything to prove it', async () => {
    const dir = scratch()
    await materialized(dir)
    for (const target of BLOCK_TARGETS)
      expect(at(dir, target)?.variant, target).toEqual({ variant: 'default', evidence: 'recorded' })
  })

  it('proves the default variant by rendering it and matching the recorded sha', async () => {
    const dir = scratch()
    await materialized(dir)
    withoutTheVariantRecord(dir)

    for (const target of BLOCK_TARGETS) {
      const entry = at(dir, target)
      expect(entry?.variant, target).toEqual({ variant: 'default', evidence: 'reconstructed' })
      expect(entry?.class, target).toBe('keep')
    }
  })

  it('proves the existing variant the same way, for a file the repository already carried', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mine\n\nProse the construct never wrote.\n')
    await materialized(dir)
    withoutTheVariantRecord(dir)

    const entry = at(dir, 'CLAUDE.md')
    expect(entry?.variant).toEqual({ variant: 'existing', evidence: 'reconstructed' })
    expect(entry?.class).toBe('keep')
  })

  it('settles nothing from a record that names no variant and a rendering that matches no sha', () => {
    const dir = frozenTree()
    for (const target of BLOCK_TARGETS) {
      const entry = at(dir, target)
      expect(entry?.class, target).toBe('unknown')
      expect(entry?.variant ?? null, target).toBeNull()
    }
  })
})

describe('a path whose variant is unknown', () => {
  it('is written in no mode, and the apply leaves it byte for byte as it was', () => {
    const dir = frozenTree()
    const before = Object.fromEntries(BLOCK_TARGETS.map(target => [target, readFileSync(path.join(dir, target), 'utf8')]))

    const result = applySync(dir, VERSION)!
    for (const target of BLOCK_TARGETS) {
      expect(result.written, target).not.toContain(target)
      expect(readFileSync(path.join(dir, target), 'utf8'), target).toBe(before[target])
      expect(readManifest(dir)!.sync?.files[target], target).toBeUndefined()
      expect(isWritable(at(dir, target)!), target).toBe(false)
    }
  })

  it('is read from the shape only to say what it looks like, never to authorise the write', () => {
    const dir = frozenTree()
    expect(at(dir, 'AGENTS.md')?.shape).toBe('default')
    expect(at(dir, 'CLAUDE.md')?.shape).toBe('existing')
    for (const target of BLOCK_TARGETS)
      expect(isWritable(at(dir, target)!), target).toBe(false)
  })
})

describe('sync records the variant it wrote with, so the next run reads a record', () => {
  it('carries the variant of every block target it wrote into the sync branch', () => {
    const dir = frozenTree()
    const recorded = { 'AGENTS.md': 'default', 'CLAUDE.md': 'existing' } as const
    writeManifest(dir, { ...readManifest(dir)!, variants: { ...recorded } })

    const written = applySync(dir, VERSION)!.written
    const after = readManifest(dir)!
    expect(written).toEqual(expect.arrayContaining([...BLOCK_TARGETS]))
    for (const target of BLOCK_TARGETS)
      expect(after.sync?.variants[target], target).toBe(recorded[target as keyof typeof recorded])
  })

  it('records the default variant for a block target it created, because creating it is what settles it', async () => {
    const dir = scratch()
    const manifest = await materialized(dir)
    const { 'AGENTS.md': dropped, ...files } = manifest.files
    expect(dropped).toBeDefined()
    rmSync(path.join(dir, 'AGENTS.md'))
    writeManifest(dir, { ...manifest, files, variants: {} })

    expect(applySync(dir, VERSION)!.written).toEqual(['AGENTS.md'])
    expect(readManifest(dir)!.sync?.variants['AGENTS.md']).toBe('default')
  })
})

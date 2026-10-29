import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { runInit } from '../src/commands/init.js'
import { templatesRoot } from '../src/materialize/templates.js'
import { MIKOSHI_PNPM, pinnedPnpm } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const machinePnpm = vi.hoisted(() => ({ version: null as string | null }))

vi.mock('../src/detect/package-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/detect/package-manager.js')>()
  return { ...actual, detectPnpmVersion: () => machinePnpm.version }
})

const SAMPLE_ONLY_CATALOG = ['@types/express', 'express', 'express-openapi-validator', 'light-my-request']

interface Manifest {
  packageManager?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface Workspace {
  catalog?: Record<string, string>
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-parity-first-start-'))
}

function existingTree(): string {
  const dir = scratch()
  writeFileSync(path.join(dir, 'README.md'), '# mine\n')
  return dir
}

async function init(dir: string, preset: string): Promise<void> {
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset, name: 'parity', yes: true, dryRun: false })
}

function manifestsUnder(dir: string): Manifest[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(file => path.basename(file) === 'package.json' && !file.includes('node_modules') && statSync(path.join(dir, file)).isFile())
    .map(file => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Manifest)
}

function catalogConsumers(dir: string): Set<string> {
  return new Set(manifestsUnder(dir).flatMap(manifest =>
    Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([, range]) => range === 'catalog:').map(([name]) => name)))
}

function catalogOf(dir: string): string[] {
  return Object.keys((parse(readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')) as Workspace).catalog ?? {})
}

function mikoshiPnpm(): string {
  const own = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')) as Manifest
  return own.packageManager!.replace(/^pnpm@/, '')
}

function workspaceTemplate(group: string): Record<string, unknown> {
  return parse(readFileSync(path.join(templatesRoot(), group, 'pnpm-workspace.yaml.eta'), 'utf8')) as Record<string, unknown>
}

describe('a fresh init leaves a main the factory starts from', () => {
  it('the monorepo preset without the sample has no catalog entry without a consumer', async () => {
    const dir = existingTree()
    await init(dir, 'monorepo')
    const consumed = catalogConsumers(dir)
    expect(catalogOf(dir).filter(entry => !consumed.has(entry))).toEqual([])
  })

  it('the monorepo preset with the sample has no catalog entry without a consumer, and every consumer has its entry', async () => {
    const dir = scratch()
    await init(dir, 'monorepo')
    const consumed = catalogConsumers(dir)
    const catalog = catalogOf(dir)
    expect(catalog.filter(entry => !consumed.has(entry))).toEqual([])
    expect([...consumed].filter(name => !catalog.includes(name))).toEqual([])
  })

  it('the sample workspace is the baseline workspace plus the sample-only catalog entries', () => {
    const baseline = workspaceTemplate('presets/monorepo/baseline')
    const sample = workspaceTemplate('presets/monorepo/sample')
    const baselineCatalog = baseline.catalog as Record<string, string>
    const sampleCatalog = sample.catalog as Record<string, string>
    expect({ ...sample, catalog: undefined }).toEqual({ ...baseline, catalog: undefined })
    expect(Object.fromEntries(Object.entries(sampleCatalog).filter(([name]) => !SAMPLE_ONLY_CATALOG.includes(name)))).toEqual(baselineCatalog)
    expect(Object.keys(sampleCatalog).filter(name => !(name in baselineCatalog)).sort()).toEqual(SAMPLE_ONLY_CATALOG)
  })

  it('init pins pnpm no lower than mikoshi', async () => {
    machinePnpm.version = '11.0.0'
    const dir = scratch()
    await init(dir, 'node-library')
    machinePnpm.version = null
    const pinned = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest).packageManager
    expect(pinned).toBe(`pnpm@${mikoshiPnpm()}`)
  })

  it('the pnpm floor is the packageManager mikoshi itself pins', () => {
    expect(MIKOSHI_PNPM).toBe(mikoshiPnpm())
  })

  it('a pnpm on the path at or above the floor is pinned as it is, one below or none pins the floor', () => {
    expect(pinnedPnpm('13.0.1')).toBe('13.0.1')
    expect(pinnedPnpm(MIKOSHI_PNPM)).toBe(MIKOSHI_PNPM)
    expect(pinnedPnpm('12.10.0')).toBe('12.10.0')
    expect(pinnedPnpm('12.4.1')).toBe(MIKOSHI_PNPM)
    expect(pinnedPnpm('9.15.0')).toBe(MIKOSHI_PNPM)
    expect(pinnedPnpm(null)).toBe(MIKOSHI_PNPM)
  })

  it('a fresh init ignores .pnpm-store', async () => {
    const dir = scratch()
    await init(dir, 'node-library')
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n')).toContain('.pnpm-store/')
  })
})

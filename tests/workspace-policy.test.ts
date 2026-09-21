import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { applySync } from '../src/commands/sync/index.js'
import { readManifest } from '../src/manifest.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const ESLINT_CONFIG = 'eslint.config.mjs'

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-policy-'))
}

function ownerAddsAPackage(dir: string, at: string, name: string): void {
  mkdirSync(path.join(dir, at), { recursive: true })
  writeFileSync(path.join(dir, at, 'package.json'), `${JSON.stringify({ name, private: true }, null, 2)}\n`)
}

function recordedImportsIn(dir: string): Record<string, string[]> {
  return readManifest(dir)!.policy!.workspaceImports
}

async function init(dir: string, write = silentWriter): Promise<void> {
  await runInit(createUi(resolveTheme({ plain: true }), write), { dir, preset: 'monorepo', name: 'policy', yes: true, dryRun: false })
}

function read(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), 'utf8')
}

function allowancesFor(source: string, directory: string): string {
  const line = source.split('\n').find(text => text.trimStart().startsWith(`'${directory}':`))
  return line?.trim() ?? `no entry for ${directory}`
}

describe('the workspace policy a repository carries is not re-derived on a re-run', () => {
  it('does not loosen eslint.config.mjs when a second init is followed by sync --apply', async () => {
    const dir = scratch()
    await init(dir)
    const strict = read(dir, ESLINT_CONFIG)
    expect(allowancesFor(strict, 'packages/shared')).toBe('\'packages/shared\': [],')

    await init(dir)
    applySync(dir, VERSION)

    expect(allowancesFor(read(dir, ESLINT_CONFIG), 'packages/shared')).toBe('\'packages/shared\': [],')
    expect(read(dir, ESLINT_CONFIG)).toBe(strict)
  })

  it('keeps the allowances recorded for a key the first run wrote, rather than deriving them again', async () => {
    const dir = scratch()
    await init(dir)
    const first = readManifest(dir)!.vars.allowedWorkspaceImports

    await init(dir)

    expect(readManifest(dir)!.vars.allowedWorkspaceImports).toBe(first)
  })

  it('gives a package that appeared since the last run a new key at the narrow default, and widens no key it had already recorded', async () => {
    const dir = scratch()
    await init(dir)
    const recorded = recordedImportsIn(dir)
    expect(recorded['packages/shared']).toEqual([])

    ownerAddsAPackage(dir, 'packages/catalog', '@policy/catalog')
    ownerAddsAPackage(dir, 'apps/web', '@policy/web')
    const lines: string[] = []
    await init(dir, text => lines.push(text))

    const after = recordedImportsIn(dir)
    for (const [dirname, allowed] of Object.entries(recorded))
      expect(after[dirname], dirname).toEqual(allowed)
    expect(after['packages/catalog']).toEqual([])
    expect(after['apps/web']).toEqual(['@policy/api', '@policy/catalog', '@policy/shared'])
  })

  it('names the keys it added, and what a later sync --apply would do to the file the policy governs', async () => {
    const dir = scratch()
    await init(dir)
    ownerAddsAPackage(dir, 'packages/catalog', '@policy/catalog')

    const lines: string[] = []
    await init(dir, text => lines.push(text))
    const printed = lines.join('')

    expect(printed).toContain('packages/catalog (may import nothing)')
    expect(printed).toContain(ESLINT_CONFIG)
    expect(printed).toContain('sync --apply')
  })

  it('reports only the two workspace variables as changed when a package appears, so a third joining them fails here', async () => {
    const dir = scratch()
    await init(dir)
    const before = readManifest(dir)!.vars
    ownerAddsAPackage(dir, 'packages/catalog', '@policy/catalog')
    await init(dir)
    const after = readManifest(dir)!.vars

    expect(Object.keys(after).filter(name => after[name] !== before[name])).toEqual(['workspacePackages', 'allowedWorkspaceImports'])
  })
})

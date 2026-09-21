import type { Manifest } from '../src/manifest.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { readManifest } from '../src/manifest.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const APPEND_TARGETS = ['AGENTS.md', 'CLAUDE.md']

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-convergence-'))
}

async function init(dir: string): Promise<void> {
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: 'node-backend', name: 'convergence', yes: true, dryRun: false })
}

function manifestOf(dir: string): Manifest {
  return readManifest(dir)!
}

function contents(dir: string): Record<string, string> {
  return Object.fromEntries(APPEND_TARGETS.map(target => [target, readFileSync(path.join(dir, target), 'utf8')]))
}

function recordedVariantsOf(dir: string): Record<string, string> {
  const recorded = manifestOf(dir).variants
  return Object.fromEntries(APPEND_TARGETS.map(target => [target, recorded[target]]))
}

describe('a re-run keeps the form the construct wrote, because the record says which one it was', () => {
  it('leaves AGENTS.md and CLAUDE.md in the default form on the second and third run of a tree it materialized from empty', async () => {
    const dir = scratch()
    await init(dir)
    const afterFirst = contents(dir)
    expect(recordedVariantsOf(dir)).toEqual({ 'AGENTS.md': 'default', 'CLAUDE.md': 'default' })

    await init(dir)
    expect(contents(dir)).toEqual(afterFirst)
    expect(recordedVariantsOf(dir)).toEqual({ 'AGENTS.md': 'default', 'CLAUDE.md': 'default' })

    await init(dir)
    expect(contents(dir)).toEqual(afterFirst)
    expect(recordedVariantsOf(dir)).toEqual({ 'AGENTS.md': 'default', 'CLAUDE.md': 'default' })
  })

  it('keeps the existing form on a file that was already there when the construct arrived, and never promotes it to the default one', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'package.json'), '{ "name": "theirs" }')
    for (const target of APPEND_TARGETS)
      writeFileSync(path.join(dir, target), `# Theirs\n\ntheir prose about ${target}\n`)

    await init(dir)
    const afterFirst = contents(dir)
    expect(recordedVariantsOf(dir)).toEqual({ 'AGENTS.md': 'existing', 'CLAUDE.md': 'existing' })

    await init(dir)
    expect(contents(dir)).toEqual(afterFirst)
    expect(recordedVariantsOf(dir)).toEqual({ 'AGENTS.md': 'existing', 'CLAUDE.md': 'existing' })

    for (const target of APPEND_TARGETS)
      expect(contents(dir)[target], target).toContain('their prose')
  })
})

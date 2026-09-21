import type { Manifest } from '../src/manifest.js'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

const POLICY_TEST = 'scripts/tests/lint/syntax-policy.test.ts'

function modelTextOf(dir: string): string {
  return readFileSync(path.join(dir, 'construct.model.json'), 'utf8')
}

function claimIdsIn(dir: string): string[] {
  return (JSON.parse(modelTextOf(dir)) as { claims: { id: string }[] }).claims.map(claim => claim.id)
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

describe('a re-run keeps the claims the record says this repository carries', () => {
  it('keeps the sample claim on the second and third run of a tree it materialized from empty, and the model converges', async () => {
    const dir = scratch()
    await init(dir)
    const afterFirst = claimIdsIn(dir)
    expect(afterFirst).toContain('lint-policy')

    await init(dir)
    const afterSecond = modelTextOf(dir)
    expect(claimIdsIn(dir)).toEqual(afterFirst)

    await init(dir)
    expect(modelTextOf(dir)).toBe(afterSecond)
    expect(claimIdsIn(dir)).toEqual(afterFirst)
  })

  it('does not make the claim on a repository the construct never wrote the sample into, however the policy test got there', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'package.json'), '{ "name": "theirs" }')
    await init(dir)
    expect(claimIdsIn(dir)).not.toContain('lint-policy')

    mkdirSync(path.join(dir, path.dirname(POLICY_TEST)), { recursive: true })
    writeFileSync(path.join(dir, POLICY_TEST), 'import { ESLint } from \'eslint\'\n')
    await init(dir)

    expect(claimIdsIn(dir)).not.toContain('lint-policy')
  })
})

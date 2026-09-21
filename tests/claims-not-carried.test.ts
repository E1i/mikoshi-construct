import type { Manifest } from '../src/manifest.js'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claimsNotCarried, printDoctor, runDoctor } from '../src/commands/doctor/index.js'
import { runInit } from '../src/commands/init.js'
import { readManifest } from '../src/manifest.js'
import { MODEL_FILE, parseModel } from '../src/model/schema.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'

const POLICY_TEST = 'scripts/tests/lint/syntax-policy.test.ts'

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-not-carried-'))
}

async function initialized(dir: string, preset: 'node-backend' | 'node-library'): Promise<string> {
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset, name: 'not-carried-fixture', yes: true, dryRun: false })
  return dir
}

function manifestOf(dir: string): Manifest {
  return readManifest(dir)!
}

function modelOf(dir: string) {
  return parseModel(readFileSync(path.join(dir, MODEL_FILE), 'utf8'), MODEL_FILE)
}

function alreadyARepository(dir: string): void {
  writeFileSync(path.join(dir, 'package.json'), '{ "name": "theirs", "scripts": { "quality": "pnpm run lint" } }')
}

function ownerWroteTheirOwnWorkflows(dir: string): void {
  alreadyARepository(dir)
  mkdirSync(path.join(dir, '.github/workflows'), { recursive: true })
  writeFileSync(path.join(dir, '.github/workflows/ci.yml'), 'name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: [{ run: npm test }]\n')
  writeFileSync(path.join(dir, '.github/workflows/security.yml'), 'name: sec\non: [push]\njobs:\n  s:\n    runs-on: ubuntu-latest\n    steps: [{ run: npm audit }]\n')
}

function report(dir: string): string[] {
  const lines: string[] = []
  printDoctor(createUi(resolveTheme({ plain: true }), line => lines.push(line)), runDoctor(dir, '0.0.0-fixture'))
  return lines
}

describe('doctor names the claims this preset can make and this repository does not carry', () => {
  it('prints no such block at all where the tree carries every expected claim', async () => {
    const dir = await initialized(scratch(), 'node-backend')

    expect(claimsNotCarried(dir, manifestOf(dir), modelOf(dir))).toEqual([])
    expect(report(dir).join('\n')).not.toContain(PLAIN_LORE.notCarried)
  })

  it('names nothing for a preset that cannot make the claim, rather than reporting its own absence', async () => {
    const dir = await initialized(scratch(), 'node-library')

    expect(modelOf(dir).claims.map(claim => claim.id)).not.toContain('lint-policy')
    expect(claimsNotCarried(dir, manifestOf(dir), modelOf(dir)).map(entry => entry.claimId)).not.toContain('lint-policy')
  })

  it('names lint-policy with the file that is not there, where the preset has a sample and the tree never took it', async () => {
    const dir = scratch()
    alreadyARepository(dir)
    await initialized(dir, 'node-backend')

    const absent = claimsNotCarried(dir, manifestOf(dir), modelOf(dir))

    expect(absent.map(entry => entry.claimId)).toContain('lint-policy')
    expect(absent.find(entry => entry.claimId === 'lint-policy')?.doesNotHold).toBe(POLICY_TEST)
  })

  it('names each of the four withheld where the owner wrote ci.yml and security.yml, one line each with its failing fact', async () => {
    const dir = scratch()
    ownerWroteTheirOwnWorkflows(dir)
    await initialized(dir, 'node-backend')

    const absent = claimsNotCarried(dir, manifestOf(dir), modelOf(dir))
    const named = new Map(absent.map(entry => [entry.claimId, entry.doesNotHold]))

    expect(named.get('no-committed-secret')).toBe('.github/workflows/security.yml')
    expect(named.get('vulnerable-dependencies-are-visible')).toBe('.github/workflows/security.yml')
    expect(named.get('every-change-passes-the-harness')).toBe('.github/workflows/ci.yml')
    expect(named.get('harness-steps')).toBe('.github/workflows/ci.yml')

    const printed = report(dir)
    for (const claimId of ['no-committed-secret', 'vulnerable-dependencies-are-visible', 'every-change-passes-the-harness', 'harness-steps'])
      expect(printed.filter(line => line.includes(claimId) && line.includes('does not carry what it would stand on'))).toHaveLength(1)
  })

  it('shows an absent claim without a level, so it cannot be read as an enforcement verdict', async () => {
    const dir = scratch()
    ownerWroteTheirOwnWorkflows(dir)
    await initialized(dir, 'node-backend')

    const lines = report(dir).filter(line => line.includes('does not carry what it would stand on'))

    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines)
      expect(line).not.toMatch(/\bL[0-4]\b/)
  })
})

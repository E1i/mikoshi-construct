import type { ClaimNotCarried } from '../src/commands/doctor/index.js'
import type { Manifest } from '../src/manifest.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const SECURITY_WORKFLOW = '.github/workflows/security.yml'
const CI_WORKFLOW = '.github/workflows/ci.yml'
const GITLEAKS_CONFIG = '.gitleaks.toml'

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

function absentIn(dir: string): Map<string, ClaimNotCarried> {
  return new Map(claimsNotCarried(dir, manifestOf(dir), modelOf(dir)).map(entry => [entry.claimId, entry]))
}

function alreadyARepository(dir: string): void {
  writeFileSync(path.join(dir, 'package.json'), '{ "name": "theirs", "scripts": { "quality": "pnpm run lint" } }')
}

function ownerWroteTheirOwnWorkflows(dir: string): void {
  alreadyARepository(dir)
  mkdirSync(path.join(dir, '.github/workflows'), { recursive: true })
  writeFileSync(path.join(dir, CI_WORKFLOW), 'name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: [{ run: npm test }]\n')
  writeFileSync(path.join(dir, SECURITY_WORKFLOW), 'name: sec\non: [push]\njobs:\n  s:\n    runs-on: ubuntu-latest\n    steps: [{ run: npm audit }]\n')
}

function madeUnreadable(dir: string, target: string): void {
  rmSync(path.join(dir, target), { force: true })
  mkdirSync(path.join(dir, target), { recursive: true })
}

function report(dir: string): string[] {
  const lines: string[] = []
  printDoctor(createUi(resolveTheme({ plain: true }), line => lines.push(line)), runDoctor(dir, '0.0.0-fixture'))
  return lines
}

describe('doctor names the claims this preset can make and this repository does not carry', () => {
  it('1: says nothing about a claim the preset cannot make, rather than reporting its own absence', async () => {
    const dir = await initialized(scratch(), 'node-library')

    expect(modelOf(dir).claims.map(claim => claim.id)).not.toContain('lint-policy')
    expect(absentIn(dir).has('lint-policy')).toBe(false)
  })

  it('2: names the file that is not there where a supporting fact does not hold', async () => {
    const dir = scratch()
    alreadyARepository(dir)
    await initialized(dir, 'node-backend')

    expect(absentIn(dir).get('lint-policy')).toEqual({ claimId: 'lint-policy', reading: 'does-not-hold', path: POLICY_TEST })
  })

  it('3 and 5: names the file that could not be read, and says the answer cannot be determined', async () => {
    const dir = scratch()
    ownerWroteTheirOwnWorkflows(dir)
    await initialized(dir, 'node-backend')
    madeUnreadable(dir, SECURITY_WORKFLOW)

    expect(absentIn(dir).get('no-committed-secret')).toEqual({ claimId: 'no-committed-secret', reading: 'unevaluable', path: SECURITY_WORKFLOW })
    expect(report(dir).some(line => line.includes('could not be read, so whether it would stand cannot be determined'))).toBe(true)
  })

  it('4: reports the fact that does not hold even where it is named after an unevaluable one', async () => {
    const dir = scratch()
    ownerWroteTheirOwnWorkflows(dir)
    await initialized(dir, 'node-backend')
    madeUnreadable(dir, SECURITY_WORKFLOW)
    rmSync(path.join(dir, GITLEAKS_CONFIG), { force: true })

    expect(absentIn(dir).get('no-committed-secret')).toEqual({ claimId: 'no-committed-secret', reading: 'does-not-hold', path: GITLEAKS_CONFIG })
  })

  it('6: leaves a fully supported claim out of this block entirely, because the enforcement trace already carries it', async () => {
    const dir = await initialized(scratch(), 'node-backend')

    expect(modelOf(dir).claims.map(claim => claim.id)).toContain('no-committed-secret')
    expect(absentIn(dir).size).toBe(0)
    expect(report(dir).join('\n')).not.toContain(PLAIN_LORE.notCarried)
  })

  it('7: names a claim whose every fact holds but which no init ever wrote, so the omission is not silent from that side either', async () => {
    const dir = scratch()
    ownerWroteTheirOwnWorkflows(dir)
    await initialized(dir, 'node-backend')
    writeFileSync(path.join(dir, CI_WORKFLOW), 'name: ci\njobs:\n  quality:\n    steps:\n      - run: pnpm run quality\n')

    expect(modelOf(dir).claims.map(claim => claim.id)).not.toContain('every-change-passes-the-harness')
    expect(absentIn(dir).get('every-change-passes-the-harness')).toEqual({ claimId: 'every-change-passes-the-harness', reading: 'every-fact-holds' })
    expect(report(dir).some(line => line.includes('every fact it would stand on holds'))).toBe(true)
  })

  it('names all five withheld on an adopted owner-authored tree \u2014 four for the workflows, one for the sample it never took \u2014 one line each, none carrying a level', async () => {
    const dir = scratch()
    ownerWroteTheirOwnWorkflows(dir)
    await initialized(dir, 'node-backend')

    const absent = absentIn(dir)
    expect(absent.get('no-committed-secret')).toMatchObject({ reading: 'does-not-hold', path: SECURITY_WORKFLOW })
    expect(absent.get('vulnerable-dependencies-are-visible')).toMatchObject({ reading: 'does-not-hold', path: SECURITY_WORKFLOW })
    expect(absent.get('every-change-passes-the-harness')).toMatchObject({ reading: 'does-not-hold', path: CI_WORKFLOW })
    expect(absent.get('harness-steps')).toMatchObject({ reading: 'does-not-hold', path: CI_WORKFLOW })

    expect(absent.get('lint-policy')).toMatchObject({ reading: 'does-not-hold', path: POLICY_TEST })
    expect(absent.size).toBe(5)

    const printed = report(dir).filter(line => line.includes('does not carry what it would stand on'))
    expect(printed).toHaveLength(5)
    for (const line of printed)
      expect(line).not.toMatch(/\bL[0-4]\b/)
  })
})

import type { DoctorResult } from '../src/commands/doctor/index.js'
import type { TemplateVars } from '../src/presets/index.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { printDoctor, runDoctor } from '../src/commands/doctor/index.js'
import { buildManifest, writeManifest } from '../src/manifest.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const VARS: TemplateVars = {
  projectName: 'fixture',
  scope: '@fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: 'contracts/api/openapi.yaml',
  contractTypesOutput: 'src/contracts/openapi.ts',
  compositionDir: 'architecture/composition',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: '',
  constructVersion: '0.0.0-fixture',
}

function repositoryWith(harnessCommand: string, packageJson: Record<string, unknown> | null): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-doctor-harness-'))
  if (packageJson != null)
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson))
  writeManifest(root, buildManifest({
    version: VARS.constructVersion,
    preset: 'node-backend',
    ai: 'claude',
    review: 'none',
    vars: { ...VARS, harnessCommand },
    written: [],
    ownedShas: {},
    contracts: false,
    previous: null,
    policy: null,
  }))
  return root
}

function plainOutput(result: DoctorResult): string {
  const lines: string[] = []
  printDoctor(createUi(resolveTheme({ plain: true, johnny: false }), text => lines.push(text)), result)
  return lines.join('')
}

describe('doctor on a harness command that is not a package script', () => {
  it('reports make check as not statically checkable, names it, and does not fail on package.json', () => {
    const result = runDoctor(repositoryWith('make check', null))
    expect(result?.harness).toEqual({ command: 'make check', state: 'unknown' })
    expect(result?.harnessProblems).toEqual([])
    expect(result?.ok).toBe(true)
    expect(plainOutput(result as DoctorResult)).toContain('`make check` is not a package script')
  })

  it('still checks a package-manager command against the package.json scripts', () => {
    const missing = runDoctor(repositoryWith('pnpm run quality', null))
    expect(missing?.harness).toEqual({ command: 'pnpm run quality', state: 'checked' })
    expect(missing?.harnessProblems).toEqual(['package.json is missing'])
    expect(missing?.ok).toBe(false)
    const present = runDoctor(repositoryWith('npm run quality', { scripts: { quality: 'eslint .' } }))
    expect(present?.harness).toEqual({ command: 'npm run quality', state: 'checked' })
    expect(present?.harnessProblems).toEqual([])
  })

  it('says nothing about an unchecked harness when the command is a package script', () => {
    const result = runDoctor(repositoryWith('pnpm run quality', { scripts: { quality: 'eslint .' } }))
    expect(plainOutput(result as DoctorResult)).not.toContain('is not a package script')
  })
})

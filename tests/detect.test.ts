import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detect } from '../src/detect/index.js'
import { declaresPnpmPackages } from '../src/detect/workspaces.js'

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-detect-'))
}

describe('detect', () => {
  it('reports an empty directory with no package manager', () => {
    const report = detect(scratch())
    expect(report.layout).toBe('empty')
    expect(report.packageManager).toBe('none')
    expect(report.existing.packageJson).toBe(false)
  })

  it('reads the package manager from lockfiles and the packageManager field', () => {
    const byLock = scratch()
    writeFileSync(path.join(byLock, 'package.json'), '{}')
    writeFileSync(path.join(byLock, 'yarn.lock'), '')
    expect(detect(byLock).packageManager).toBe('yarn')

    const byField = scratch()
    writeFileSync(path.join(byField, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0' }))
    writeFileSync(path.join(byField, 'package-lock.json'), '')
    expect(detect(byField).packageManager).toBe('pnpm')
  })

  it('recognizes a single-package repo and a workspace monorepo', () => {
    const single = scratch()
    writeFileSync(path.join(single, 'package.json'), '{}')
    mkdirSync(path.join(single, 'src'))
    expect(detect(single).layout).toBe('single')

    const mono = scratch()
    writeFileSync(path.join(mono, 'package.json'), '{}')
    writeFileSync(path.join(mono, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
    writeFileSync(path.join(mono, 'turbo.json'), '{}')
    mkdirSync(path.join(mono, 'apps'))
    const report = detect(mono)
    expect(report.layout).toBe('monorepo')
    expect(report.monorepoTools).toEqual(['pnpm-workspace', 'turbo'])
    expect(report.workspaceDirs).toEqual(['apps'])
  })

  it('treats a pnpm-workspace.yaml that only carries settings as a single package', () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'package.json'), '{}')
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'minimumReleaseAgeExcludePrune: true\n\nshellEmulator: true\n\nallowBuilds:\n  esbuild: true\n')
    const report = detect(dir)
    expect(report.layout).toBe('single')
    expect(report.monorepoTools).toEqual([])
  })

  it('reads the packages list in every shape pnpm accepts', () => {
    const declares = (yaml: string): boolean => {
      const dir = scratch()
      writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), yaml)
      return declaresPnpmPackages(dir)
    }
    expect(declares('packages:\n  - apps/*\n')).toBe(true)
    expect(declares('packages: [\'apps/*\', \'packages/*\']\n')).toBe(true)
    expect(declares('shellEmulator: true\npackages:\n  # the apps\n  - apps/*\n')).toBe(true)
    expect(declares('packages: []\n')).toBe(false)
    expect(declares('packages:\nshellEmulator: true\n')).toBe(false)
    expect(declares('shellEmulator: true\n')).toBe(false)
    expect(declares('catalog:\n  packages: ^1.0.0\n')).toBe(false)
    expect(declaresPnpmPackages(scratch())).toBe(false)
  })

  it('counts an npm workspaces field only when it lists something', () => {
    const withList = scratch()
    writeFileSync(path.join(withList, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    expect(detect(withList).monorepoTools).toEqual(['npm-workspaces'])

    const nested = scratch()
    writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ workspaces: { packages: ['apps/*'] } }))
    expect(detect(nested).monorepoTools).toEqual(['npm-workspaces'])

    const empty = scratch()
    writeFileSync(path.join(empty, 'package.json'), JSON.stringify({ workspaces: [] }))
    mkdirSync(path.join(empty, 'src'))
    expect(detect(empty).monorepoTools).toEqual([])
    expect(detect(empty).layout).toBe('single')
  })

  it('does not recognize a directory with unrelated files', () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'notes.txt'), 'hello')
    expect(detect(dir).layout).toBe('unknown')
  })

  it('finds existing contracts, AI files and construct.json', () => {
    const dir = scratch()
    mkdirSync(path.join(dir, 'contracts', 'api'), { recursive: true })
    writeFileSync(path.join(dir, 'contracts', 'api', 'openapi.yaml'), 'openapi: 3.1.0')
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# x')
    writeFileSync(path.join(dir, 'construct.json'), '{}')
    const { existing } = detect(dir)
    expect(existing.openapi).toBe('contracts/api/openapi.yaml')
    expect(existing.claudeMd).toBe(true)
    expect(existing.constructJson).toBe(true)
  })
})

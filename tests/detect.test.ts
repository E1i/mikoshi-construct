import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detect } from '../src/detect/index.js'

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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectEntryPoints, entryPointKindOf, importReach, packageDirOf } from '../../src/detect/entry-points.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'entry-points-'))
  roots.push(root)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

const ENTRY_KINDS: Record<string, string | null> = {
  'app/settings/page.tsx': 'page',
  'src/app/layout.tsx': 'page',
  'pages/index.vue': 'page',
  'apps/web/pages/about.tsx': 'page',
  'src/routes/blog/+page.svelte': 'page',
  'index.html': 'page',
  'pages/api/users.ts': 'endpoint',
  'app/api/users/route.ts': 'endpoint',
  'src/routes/api/+server.ts': 'endpoint',
  'src/commands/app/page.ts': null,
  'src/window/shell.tsx': null,
}

describe('the entry points of the stack are facts of detect', () => {
  it.each(Object.entries(ENTRY_KINDS))('%s is entry point kind %s by its framework convention', (file, kind) => {
    expect(entryPointKindOf(file)).toBe(kind)
  })

  it('lists the bins, main and exports of every package and the pages and endpoints on disk', () => {
    const root = tree({
      'package.json': JSON.stringify({ bin: 'dist/cli.js', main: './dist/index.js', exports: { '.': { import: './dist/index.js' } } }),
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
      'apps/web/app/page.tsx': '',
      'apps/web/app/api/health/route.ts': '',
      'apps/web/app/ui/button.tsx': '',
    })

    expect(detectEntryPoints(root)).toEqual([
      { kind: 'bin', path: 'dist/cli.js', declaredIn: 'package.json', packageDir: '' },
      { kind: 'main', path: 'dist/index.js', declaredIn: 'package.json', packageDir: '' },
      { kind: 'endpoint', path: 'apps/web/app/api/health/route.ts', declaredIn: null, packageDir: 'apps/web' },
      { kind: 'page', path: 'apps/web/app/page.tsx', declaredIn: null, packageDir: 'apps/web' },
    ])
  })

  it('reaches every module the entry imports, through .js specifiers, index files and re-exports', () => {
    const root = tree({
      'src/cli.ts': 'import { a } from \'./a.js\'\nexport * from \'./b\'\n',
      'src/a.ts': 'const c = await import(\'./c/index.js\')\n',
      'src/b/index.ts': '',
      'src/c/index.ts': '',
      'src/island.ts': '',
    })

    expect(importReach(root, ['src/cli.ts'])).toEqual(['src/a.ts', 'src/b/index.ts', 'src/c/index.ts', 'src/cli.ts'])
  })

  it('reads package exports on their own, with no main to repeat them', () => {
    const root = tree({ 'packages/core/package.json': JSON.stringify({ name: 'core', exports: { '.': './src/index.ts' } }) })

    expect(detectEntryPoints(root)).toEqual([{ kind: 'main', path: 'packages/core/src/index.ts', declaredIn: 'packages/core/package.json', packageDir: 'packages/core' }])
  })

  it('names the package a path lies in, and the root for a path in no workspace package', () => {
    const root = tree({ 'apps/web/package.json': '{}', 'apps/web/src/a.ts': '' })

    expect([packageDirOf(root, 'apps/web/src/a.ts'), packageDirOf(root, 'src/a.ts')]).toEqual(['apps/web', ''])
  })

  it('leaves a node_modules directory under a convention root out of the pages', () => {
    const root = tree({ 'pages/index.tsx': '', 'pages/node_modules/lib/page.tsx': '' })

    expect(detectEntryPoints(root).map(entry => entry.path)).toEqual(['pages/index.tsx'])
  })

  it('follows a require() specifier', () => {
    const root = tree({ 'src/cli.cjs': 'const r = require(\'./r.cjs\')\n', 'src/r.cjs': '' })

    expect(importReach(root, ['src/cli.cjs'])).toEqual(['src/cli.cjs', 'src/r.cjs'])
  })

  it('reaches no file outside the inspected tree', () => {
    const parent = tree({ 'outside.ts': '', 'repo/src/cli.ts': 'import \'../../outside.js\'\n' })

    expect(importReach(path.join(parent, 'repo'), ['src/cli.ts'])).toEqual(['src/cli.ts'])
  })
})

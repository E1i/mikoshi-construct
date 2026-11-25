import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectEntryPoints, entryPointKindOf, importReach } from '../../src/detect/entry-points.js'

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
      { kind: 'bin', path: 'dist/cli.js', declaredIn: 'package.json' },
      { kind: 'main', path: 'dist/index.js', declaredIn: 'package.json' },
      { kind: 'endpoint', path: 'apps/web/app/api/health/route.ts', declaredIn: null },
      { kind: 'page', path: 'apps/web/app/page.tsx', declaredIn: null },
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
})

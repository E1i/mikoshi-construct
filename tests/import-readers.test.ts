import { describe, expect, it } from 'vitest'
import { importReaderFor } from '../src/model/imports/index.js'
import { parseJsonc } from '../src/model/imports/jsonc.js'
import { readPathAliases } from '../src/model/imports/path-aliases.js'
import { scriptsOf, sfcScriptReader } from '../src/model/imports/sfc-script.js'
import { tsJsReader } from '../src/model/imports/ts-js.js'
import { globMatcher, pnpmWorkspacePatterns, readWorkspaces } from '../src/model/imports/workspaces.js'

describe('each file goes to the adapter that recognises it', () => {
  it.each([
    ['src/a.ts', tsJsReader],
    ['src/a.tsx', tsJsReader],
    ['src/a.mjs', tsJsReader],
    ['src/a.cjs', tsJsReader],
    ['src/A.vue', sfcScriptReader],
    ['src/A.svelte', sfcScriptReader],
    ['src/a.astro', sfcScriptReader],
  ])('%s', (file, reader) => {
    expect(importReaderFor(file)).toBe(reader)
  })

  it('gives a file no adapter recognises no reader', () => {
    expect(importReaderFor('README.md')).toBeUndefined()
    expect(importReaderFor('src/shader.glsl')).toBeUndefined()
  })
})

describe('the sfc-script adapter hands only the script blocks to the TS/JS adapter', () => {
  it('keeps every script block and the leading fence, blanks the rest and keeps each line where it was', () => {
    const source = '---\nimport A from \'./a.ts\'\n---\n<p>import B from \'./b.ts\'</p>\n<script lang="ts">\nimport C from \'./c.ts\'\n</script>\n<script>import D from \'./d.ts\'</script>\n'
    const kept = scriptsOf(source)
    expect(kept.split('\n')).toHaveLength(source.split('\n').length)
    expect(sfcScriptReader.read(source).imports.map(entry => `${entry.line} ${entry.specifier}`)).toEqual(['2 ./a.ts', '6 ./c.ts', '8 ./d.ts'])
  })

  it('keeps a script block in place behind markup that holds a character outside the basic plane', () => {
    expect(sfcScriptReader.read('<p>🌸🌸</p>\n<script>\nimport { go } from \'./go.ts\'\ngo()\n</script>\n').imports.map(entry => `${entry.line} ${entry.specifier} ${entry.bindings.join(',')}`)).toEqual(['3 ./go.ts go'])
  })

  it('reads nothing from markup outside a script block', () => {
    expect(sfcScriptReader.read('<template>\n  <p>import { x } from \'./x.ts\'</p>\n</template>\n').imports).toEqual([])
  })

  it('takes a fence only at the start of the file', () => {
    expect(sfcScriptReader.read('<p>a</p>\n---\nimport A from \'./a.ts\'\n---\n').imports).toEqual([])
  })

  it('reads the calls in a script block through the bindings it imports', () => {
    expect(sfcScriptReader.read('<script>\nimport { go } from \'./go.ts\'\ngo()\n</script>\n').calls).toEqual([{ name: 'go', member: false, line: 3 }])
  })
})

function repository(files: Record<string, string>): { tracked: Set<string>, read: (file: string) => string | null } {
  return { tracked: new Set(Object.keys(files)), read: file => files[file] ?? null }
}

describe('a tsconfig or jsconfig is read as the JSON with comments and trailing commas it is', () => {
  it('drops comments and trailing commas outside strings and keeps them inside', () => {
    expect(parseJsonc('{\n  // a\n  "url": "http://x/*y*/",\n  /* b */ "list": [1, 2,],\n  "comma": ",}",\n}\n')).toEqual({ url: 'http://x/*y*/', list: [1, 2], comma: ',}' })
  })

  it('reads a file that is not JSON as nothing', () => {
    expect(parseJsonc('{ nope')).toBeNull()
  })
})

describe('path aliases come from the nearest tsconfig or jsconfig of the importing file', () => {
  it('prefers the exact pattern, then the longest prefix, and keeps every substitution in order', () => {
    const { tracked, read } = repository({ 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src', paths: { '@/*': ['*', 'gen/*'], '@/ui/*': ['ui/*'], '@/ui/button': ['ui/button/index'] } } }) })
    const targets = readPathAliases(tracked, read)
    expect(targets('src/a.ts', '@/ui/button')).toEqual(['src/ui/button/index'])
    expect(targets('src/a.ts', '@/ui/card')).toEqual(['src/ui/card'])
    expect(targets('src/a.ts', '@/lib/x')).toEqual(['src/lib/x', 'src/gen/lib/x'])
    expect(targets('src/a.ts', 'react')).toBeNull()
  })

  it('resolves paths against the config that declares them when no baseUrl is set, and follows a relative extends', () => {
    const { tracked, read } = repository({
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { paths: { '#shared/*': ['./shared/*'] } } }),
      'apps/web/jsconfig.json': JSON.stringify({ extends: '../../tsconfig.base' }),
      'apps/api/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { baseUrl: '.' } }),
    })
    const targets = readPathAliases(tracked, read)
    expect(targets('apps/web/src/page.js', '#shared/log')).toEqual(['shared/log'])
    expect(targets('apps/api/src/main.ts', '#shared/log')).toEqual(['apps/api/shared/log'])
    expect(targets('tools/run.ts', '#shared/log')).toBeNull()
  })

  it('reads no alias from a config that extends itself past the depth it follows', () => {
    const { tracked, read } = repository({ 'tsconfig.json': JSON.stringify({ extends: './tsconfig.json' }) })
    expect(readPathAliases(tracked, read)('a.ts', '@/x')).toBeNull()
  })
})

describe('workspace packages come from the package manager\'s own workspace list', () => {
  it('reads the packages list of pnpm-workspace.yaml in block and flow form, without its comments', () => {
    expect(pnpmWorkspacePatterns('# top\npackages:\n  # apps\n  - \'apps/*\'\n\n  - "libs/**" # all\n  - !libs/old\ncatalog:\n  - nope\n')).toEqual(['apps/*', 'libs/**', '!libs/old'])
    expect(pnpmWorkspacePatterns('packages: [apps/*, \'libs/*\']\n')).toEqual(['apps/*', 'libs/*'])
    expect(pnpmWorkspacePatterns('catalog: {}\n')).toEqual([])
  })

  it.each([
    ['packages/*', 'packages/core', true],
    ['packages/*', 'packages/core/sub', false],
    ['./libs/**', 'libs/ui/button', true],
    ['apps/web-*', 'apps/web-admin', true],
    ['apps/web.x', 'apps/webax', false],
  ])('%s matches %s: %s', (glob, directory, matches) => {
    expect(globMatcher(glob).test(directory)).toBe(matches)
  })

  it('names a listed package by its manifest, leaves out an excluded one, and points at its exports, module, main, then its directory', () => {
    const files = {
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n  - \'!packages/old\'\n',
      'package.json': JSON.stringify({ workspaces: ['tools/*'] }),
      'packages/core/package.json': JSON.stringify({ name: '@m/core', exports: { '.': { types: './dist/index.d.ts', default: './src/index.ts' }, './money': './src/money.ts' } }),
      'packages/old/package.json': JSON.stringify({ name: 'old' }),
      'tools/cli/package.json': JSON.stringify({ name: 'cli', module: './esm/index.js', main: './cjs/index.js' }),
      'tools/bare/package.json': JSON.stringify({ name: 'bare' }),
    }
    const { read } = repository(files)
    const targets = readWorkspaces(Object.keys(files), read)
    expect(targets('a.ts', '@m/core')).toEqual(['packages/core/dist/index.d.ts', 'packages/core/src/index.ts', 'packages/core'])
    expect(targets('a.ts', '@m/core/money')).toEqual(['packages/core/src/money.ts', 'packages/core/money'])
    expect(targets('a.ts', 'cli')).toEqual(['tools/cli/esm/index.js', 'tools/cli/cjs/index.js', 'tools/cli'])
    expect(targets('a.ts', 'bare/x')).toEqual(['tools/bare/x'])
    expect(targets('a.ts', 'old')).toBeNull()
    expect(targets('a.ts', '@m/core-extra')).toBeNull()
  })
})

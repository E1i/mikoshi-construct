import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contourOf, declaresContract, discoverContours, ROOT_CONTOUR } from '../src/model/contours.js'
import { discoverMechanics } from '../src/model/discovery.js'

type Tree = Record<string, string>

function contoursOf(tree: Tree): ReturnType<typeof discoverContours> {
  const files = Object.keys(tree).sort()
  const tracked = new Set(files)
  return discoverContours('fallback', files, file => tree[file] ?? null, target => tracked.has(target) ? target : null)
}

function repository(tree: Tree): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'model-contours-'))
  for (const [file, content] of Object.entries(tree)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return dir
}

const WORKSPACE: Tree = {
  'package.json': JSON.stringify({ name: 'shop', private: true }),
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'packages/core/package.json': JSON.stringify({ name: '@shop/core', exports: { '.': './src/index.ts' } }),
  'packages/core/src/index.ts': 'export * from \'./price.js\'\n',
  'packages/core/src/price.ts': 'export const price = 1\n',
  'packages/app/package.json': JSON.stringify({ name: '@shop/app', bin: { shop: './bin/shop.js' } }),
  'packages/app/bin/shop.js': '',
  'packages/app/src/main.ts': 'import { price } from \'../../core/src/price.js\'\n',
  'api/orders.yaml': 'openapi: 3.1.0\ninfo:\n  title: orders\n',
  'schemas/order.json': JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }),
  'contract/surface.json': JSON.stringify({ commands: [] }),
  'tsconfig.json': JSON.stringify({ references: [{ path: './tools' }] }),
  'tools/tsconfig.json': '{}',
  'tools/gen.ts': '',
}

describe('a contour comes only from a boundary the repository declares', () => {
  it('reads the root manifest, the workspace packages, the project references and the self-declaring contract documents', () => {
    expect(contoursOf(WORKSPACE).map(contour => [contour.id, contour.kind, contour.declaredBy])).toEqual([
      [ROOT_CONTOUR, 'package', 'package.json'],
      ['api', 'contract', 'api/orders.yaml'],
      ['packages/app', 'workspace', 'packages/app/package.json'],
      ['packages/core', 'workspace', 'packages/core/package.json'],
      ['schemas', 'contract', 'schemas/order.json'],
      ['tools', 'reference', 'tsconfig.json'],
    ])
  })

  it('takes a contour\'s entries from the files its manifest names as public, and a contract\'s from its documents', () => {
    const byId = new Map(contoursOf(WORKSPACE).map(contour => [contour.id, contour]))
    expect(byId.get('packages/core')?.entries).toEqual(['packages/core/src/index.ts'])
    expect(byId.get('packages/app')?.entries).toEqual(['packages/app/bin/shop.js'])
    expect(byId.get('api')?.entries).toEqual(['api/orders.yaml'])
    expect(byId.get(ROOT_CONTOUR)?.name).toBe('shop')
  })

  it('makes no contour of a directory by its name: a contract directory whose documents declare no format is not one', () => {
    expect(contoursOf(WORKSPACE).map(contour => contour.id)).not.toContain('contract')
    expect(declaresContract('contract/surface.json', WORKSPACE['contract/surface.json']!)).toBe(false)
    expect(declaresContract('docs/api.yml', 'asyncapi: 2.6.0\n')).toBe(true)
    expect(declaresContract('docs/api.json', JSON.stringify({ swagger: '2.0' }))).toBe(true)
    expect(declaresContract('docs/data.json', JSON.stringify({ $schema: 'https://example.test/schema' }))).toBe(false)
  })

  it('names the root after the directory when no manifest names it, and declares it by the tracked file list', () => {
    expect(contoursOf({ 'main.ts': '' })).toEqual([{ id: ROOT_CONTOUR, name: 'fallback', kind: 'package', declaredBy: 'git ls-files -z', entries: [] }])
  })

  it('gives a file to the innermost contour whose directory holds it, and to the root otherwise', () => {
    const contours = [{ id: ROOT_CONTOUR, name: 'r', kind: 'package' as const, declaredBy: 'package.json', entries: [] }, { id: 'packages/a', name: 'a', kind: 'workspace' as const, declaredBy: 'x', entries: [] }, { id: 'packages/a/schemas', name: 's', kind: 'contract' as const, declaredBy: 'y', entries: [] }]
    expect(contourOf('packages/a/schemas/x.json', contours)).toBe('packages/a/schemas')
    expect(contourOf('packages/a/src/x.ts', contours)).toBe('packages/a')
    expect(contourOf('packages/ab/x.ts', contours)).toBe(ROOT_CONTOUR)
  })

  it('writes the contours into the mechanics discovery reads from a git repository, entries resolved to tracked files', () => {
    const mechanics = discoverMechanics(repository(WORKSPACE))
    expect(mechanics.contours.map(contour => contour.id)).toEqual([ROOT_CONTOUR, 'api', 'packages/app', 'packages/core', 'schemas', 'tools'])
    expect(mechanics.contours.find(contour => contour.id === 'packages/core')?.entries).toEqual(['packages/core/src/index.ts'])
  })
})

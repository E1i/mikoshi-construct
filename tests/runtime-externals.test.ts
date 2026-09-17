import { glob, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Manifest
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

async function bareImportsUnderSrc(): Promise<string[]> {
  const found = new Set<string>()
  for await (const file of glob('src/**/*.ts', { cwd: root })) {
    const source = await readFile(path.join(root, file), 'utf8')
    for (const match of source.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
      const specifier = match[1]
      if (specifier.startsWith('.') || specifier.startsWith('node:'))
        continue
      found.add(packageNameOf(specifier))
    }
  }
  return [...found].sort()
}

describe('modules tsup leaves external, which an installed package must resolve on its own', () => {
  it('declares every bundler external in dependencies, not devDependencies', async () => {
    const { dependencies = {}, devDependencies = {}, peerDependencies = {} } = await manifest()
    const externals = [...new Set([...Object.keys(dependencies), ...Object.keys(peerDependencies)])]

    expect(externals.length).toBeGreaterThan(0)
    expect(externals.filter(name => name in devDependencies)).toEqual([])
  })

  it('resolves no bare import under src to a devDependency', async () => {
    const { dependencies = {}, devDependencies = {} } = await manifest()
    const imports = await bareImportsUnderSrc()

    expect(imports.filter(name => name in devDependencies)).toEqual([])
    expect(imports.filter(name => !(name in dependencies))).toEqual([])
  })
})

import type { Options } from 'tsup'
import { cpSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'tsup'

export const OUT_DIR = 'dist'
export const FACTORY_DIRECTORIES = ['bus', 'decisions', 'ghosts', 'miko', 'owner', 'shift'] as const

const FACTORY_SCRIPT = new RegExp(`^node --import tsx (scripts/(?:${FACTORY_DIRECTORIES.join('|')})/[\\w-]+\\.ts)(?:\\s|$)`)
const STATIC_IMPORT = /^(?:import|export) (?!type )(?:(?:\{[^}]*\}|\* as \w+|\*|\w+(?:, \{[^}]*\})?) from )?['"](\.{1,2}\/[^'"]+)['"]/gm
const DYNAMIC_IMPORT = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g
const NAMED_SCRIPT = /(?<![\w./-])((?:scripts|src)\/[\w./-]+\.ts)\b/g
const BESIDE_THE_MODULE = /path\.(?:join|resolve)\(import\.meta\.dirname((?:,\s*'[^']*')*)\)/g
const ROOT_CONSTANT = /const (\w+) = path\.(?:join|resolve)\(import\.meta\.dirname((?:,\s*'[^']*')*)\)/g
const SEGMENT = /'([^']*)'/g
const TEST_SOURCES = 'scripts/tests/'
const INSTALLED_DEPENDENCIES = 'node_modules/'
const TYPESCRIPT = '.ts'
const ROOT_FILES_ONLY = '!*/**'
const NESTED_FILES_ONLY = '!*'

function packageScripts(): Record<string, string> {
  return (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts
}

function segmentsOf(list: string): string[] {
  return [...list.matchAll(SEGMENT)].map(([, segment]) => segment!)
}

function escaped(name: string): string {
  return name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function factoryEntries(scripts: Record<string, string> = packageScripts()): string[] {
  return [...new Set(Object.values(scripts).flatMap(command => FACTORY_SCRIPT.exec(command)?.[1] ?? []))].sort()
}

export function importsOf(source: string, text: string): string[] {
  return [...text.matchAll(STATIC_IMPORT), ...text.matchAll(DYNAMIC_IMPORT)]
    .map(([, specifier]) => path.join(path.dirname(source), specifier!).replace(/\.js$/, TYPESCRIPT))
}

export function scriptsNamedBy(text: string): string[] {
  return [...text.matchAll(NAMED_SCRIPT)].map(([, named]) => named!).filter(named => !named.startsWith(TEST_SOURCES))
}

export function locatedBy(source: string, text: string): string[] {
  const here = path.dirname(source)
  const roots = [...text.matchAll(ROOT_CONSTANT)].map(([, name, segments]) => [name!, path.join(here, ...segmentsOf(segments!))] as const)
  const fromRoots = roots.flatMap(([name, root]) => [...text.matchAll(new RegExp(`path\\.(?:join|resolve)\\(${escaped(name)}((?:,\\s*'[^']*')+)\\)`, 'g'))]
    .map(([, segments]) => path.join(root, ...segmentsOf(segments!))))
  const beside = [...text.matchAll(BESIDE_THE_MODULE)].map(([, segments]) => path.join(here, ...segmentsOf(segments!)))
  return [...beside, ...fromRoots].filter(located => path.relative(located, here).startsWith('..') && !located.startsWith(INSTALLED_DEPENDENCIES))
}

function reach(entries: readonly string[]): { sources: string[], assets: string[] } {
  const sources = new Set<string>()
  const assets = new Set<string>()
  const pending = [...entries]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (sources.has(next))
      continue
    sources.add(next)
    const text = readFileSync(next, 'utf8')
    const located = locatedBy(next, text).filter(file => existsSync(file))
    pending.push(...importsOf(next, text), ...scriptsNamedBy(text).filter(file => existsSync(file)), ...located.filter(file => file.endsWith(TYPESCRIPT)))
    for (const asset of located.filter(file => !file.endsWith(TYPESCRIPT)))
      assets.add(asset)
  }
  return { sources: [...sources].sort(), assets: [...assets].sort() }
}

export function factoryGraph(entries: readonly string[] = factoryEntries()): string[] {
  return reach(entries).sources
}

export function factoryAssets(entries: readonly string[] = factoryEntries()): string[] {
  return reach(entries).assets
}

export function copyFactoryAssets(outDir: string): void {
  for (const asset of factoryAssets())
    cpSync(asset, path.join(outDir, asset), { recursive: true })
}

const shared = {
  format: ['esm'],
  target: 'node22',
  outDir: OUT_DIR,
  removeNodeProtocol: false,
  banner: { js: '#!/usr/bin/env -S node --disable-warning=ExperimentalWarning' },
} satisfies Options

export const productBuild = {
  ...shared,
  entry: ['src/cli.ts'],
  clean: [ROOT_FILES_ONLY],
} satisfies Options

export const factoryBuild = {
  ...shared,
  entry: factoryGraph(),
  bundle: false,
  clean: [NESTED_FILES_ONLY],
  esbuildOptions(options) {
    options.outbase = '.'
  },
  async onSuccess() {
    copyFactoryAssets(OUT_DIR)
  },
} satisfies Options

export default defineConfig([productBuild, factoryBuild])

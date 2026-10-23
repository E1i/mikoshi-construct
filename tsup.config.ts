import type { Options } from 'tsup'
import { cpSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'tsup'

export const OUT_DIR = 'dist'
export const FACTORY_DIRECTORIES = ['bus', 'decisions', 'ghosts', 'miko', 'owner', 'shift'] as const
export const FACTORY_ASSETS = ['.claude/hooks/eddies-measure.mjs', 'contract/contours', 'scripts/ci/sandbox-failing.jsonl', 'scripts/shift/header.md'] as const

const FACTORY_SCRIPT = new RegExp(`^node --import tsx (scripts/(?:${FACTORY_DIRECTORIES.join('|')})/[\\w-]+\\.ts)(?:\\s|$)`)
const RUNTIME_IMPORT = /^(?:import|export) (?!type )(?:(?:\{[^}]*\}|\* as \w+|\*|\w+(?:, \{[^}]*\})?) from )?'(\.{1,2}\/[^']+)'/gm
const ROOT_FILES_ONLY = '!*/**'
const NESTED_FILES_ONLY = '!*'

function packageScripts(): Record<string, string> {
  return (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts
}

export function factoryEntries(scripts: Record<string, string> = packageScripts()): string[] {
  return [...new Set(Object.values(scripts).flatMap(command => FACTORY_SCRIPT.exec(command)?.[1] ?? []))].sort()
}

export function factoryGraph(entries: readonly string[] = factoryEntries()): string[] {
  const reached = new Set<string>()
  const pending = [...entries]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (reached.has(next))
      continue
    reached.add(next)
    for (const [, specifier] of readFileSync(next, 'utf8').matchAll(RUNTIME_IMPORT))
      pending.push(path.join(path.dirname(next), specifier).replace(/\.js$/, '.ts'))
  }
  return [...reached].sort()
}

export function copyFactoryAssets(outDir: string): void {
  for (const asset of FACTORY_ASSETS)
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

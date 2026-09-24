import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { INTERNAL_MODULES } from '../eslint.config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const eslint = new ESLint({ cwd: root })

function sourceFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? sourceFiles(path.join(directory, entry.name))
      : (entry.name.endsWith('.ts') ? [path.join(directory, entry.name)] : []),
  )
}

function internalImportsOf(file: string): string[] {
  const specifiers = [...readFileSync(path.join(root, file), 'utf8').matchAll(/from '(\.[^']*)'/g)].map(match => match[1])
  const named = specifiers.map((specifier) => {
    const resolved = path.relative(root, path.resolve(path.dirname(path.join(root, file)), specifier))
    return resolved.split(path.sep)[1]?.replace(/\.js$/, '') ?? ''
  })
  return [...new Set(named.filter(name => INTERNAL_MODULES.includes(name)))]
}

async function boundedModules(file: string): Promise<number> {
  const resolved = await eslint.calculateConfigForFile(path.join(root, file))
  const rule = resolved.rules['no-restricted-imports'] as [number, { patterns?: { group?: string[] }[] }] | undefined
  return (rule?.[1].patterns ?? []).flatMap(pattern => pattern.group ?? []).length
}

async function violations(file: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: path.join(root, file) })
  return result.messages.map(message => message.ruleId ?? '').filter(rule => rule === 'no-restricted-imports' || rule === 'no-restricted-syntax')
}

describe('the dependency policy names every top-level module of src', () => {
  it('lists each directory and each .ts file directly under src in INTERNAL_MODULES', () => {
    const topLevel = readdirSync(path.join(root, 'src'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.name.endsWith('.ts'))
      .map(entry => entry.name.replace(/\.ts$/, ''))
    expect(topLevel.filter(name => !INTERNAL_MODULES.includes(name))).toEqual([])
  })
})

describe('every source file that names an internal import is covered by a boundary', () => {
  it('leaves no importing file outside ALLOWED_INTERNAL_IMPORTS', async () => {
    const importing = sourceFiles('src').filter(file => internalImportsOf(file).length > 0)
    const uncovered: string[] = []
    for (const file of importing) {
      if (await boundedModules(file) === 0)
        uncovered.push(file)
    }
    expect(uncovered).toEqual([])
  })

  it('asks nothing of a file that names no internal import, so an entry is never empty ceremony', async () => {
    expect(internalImportsOf('src/record-ahead.ts')).toEqual([])
    expect(internalImportsOf('src/version.ts')).toEqual([])
    expect(await boundedModules('src/record-ahead.ts')).toBe(0)
    expect(await boundedModules('src/version.ts')).toBe(0)
  })
})

describe('dependency policy in eslint.config.mjs', () => {
  it('lets dependencies point only one way inside src', async () => {
    expect(await violations('src/detect/probe.ts', 'import { createUi } from \'../ui/console.js\'\n\nexport const probe = createUi\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/presets/probe.ts', 'import { planMaterialize } from \'../materialize/plan.js\'\n\nexport const probe = planMaterialize\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/ui/probe.ts', 'import { readManifest } from \'../manifest.js\'\n\nexport const probe = readManifest\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/presets/probe.ts', 'import { detect } from \'../detect/index.js\'\n\nexport const probe = detect\n')).toEqual([])
    expect(await violations('src/commands/probe.ts', 'import { applyPlan } from \'../materialize/apply.js\'\n\nexport const probe = applyPlan\n')).toEqual([])
  })

  it('lets sync read the manifest and the materialization it classifies, and nothing that reports', async () => {
    expect(await violations('src/sync/probe.ts', 'import { recordedShas } from \'../manifest.js\'\n\nexport const probe = recordedShas\n')).toEqual([])
    expect(await violations('src/sync/probe.ts', 'import { strategyFor } from \'../materialize/strategies.js\'\n\nexport const probe = strategyFor\n')).toEqual([])
    expect(await violations('src/sync/probe.ts', 'import { createUi } from \'../ui/console.js\'\n\nexport const probe = createUi\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/materialize/probe.ts', 'import { classifyPath } from \'../sync/classify.js\'\n\nexport const probe = classifyPath\n')).toEqual(['no-restricted-imports'])
  })

  it('lets the failure reader reach the vocabulary it renders with, and nothing that holds a record', async () => {
    expect(await violations('src/failure.ts', 'import type { Ui } from \'./ui/console.js\'\n\nexport const probe = (ui: Ui) => ui\n')).toEqual([])
    expect(await violations('src/failure.ts', 'import { readManifest } from \'./manifest.js\'\n\nexport const probe = readManifest\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/failure.ts', 'import { parseModel } from \'./model/schema.js\'\n\nexport const probe = parseModel\n')).toEqual(['no-restricted-imports'])
  })

  it('lets the program compose the commands and reach no record behind them', async () => {
    expect(await violations('src/program.ts', 'import { runDoctor } from \'./commands/doctor/index.js\'\n\nexport const probe = runDoctor\n')).toEqual([])
    expect(await violations('src/program.ts', 'import { createUi } from \'./ui/console.js\'\n\nexport const probe = createUi\n')).toEqual([])
    expect(await violations('src/program.ts', 'import { reported } from \'./failure.js\'\n\nexport const probe = reported\n')).toEqual([])
    expect(await violations('src/program.ts', 'import { readManifest } from \'./manifest.js\'\n\nexport const probe = readManifest\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/program.ts', 'import { runSync } from \'./sync/index.js\'\n\nexport const probe = runSync\n')).toEqual(['no-restricted-imports'])
  })

  it('keeps the entry point to running the program', async () => {
    expect(await violations('src/cli.ts', 'import { main } from \'./program.js\'\n\nexport const probe = main\n')).toEqual([])
    expect(await violations('src/cli.ts', 'import { runDoctor } from \'./commands/doctor/index.js\'\n\nexport const probe = runDoctor\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/cli.ts', 'import { createUi } from \'./ui/console.js\'\n\nexport const probe = createUi\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/cli.ts', 'import { reported } from \'./failure.js\'\n\nexport const probe = reported\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/commands/probe.ts', 'import { main } from \'../program.js\'\n\nexport const probe = main\n')).toEqual(['no-restricted-imports'])
  })

  it('lets only the readers of a versioned record and the failure reader reach the record-ahead error', async () => {
    const ahead = (base: string) => `import { RecordAheadOfReader } from '${base}/record-ahead.js'\n\nexport const probe = RecordAheadOfReader\n`
    expect(await violations('src/manifest.ts', ahead('.'))).toEqual([])
    expect(await violations('src/model/probe.ts', ahead('..'))).toEqual([])
    expect(await violations('src/failure.ts', ahead('.'))).toEqual([])
    expect(await violations('src/detect/probe.ts', ahead('..'))).toEqual(['no-restricted-imports'])
    expect(await violations('src/ui/probe.ts', ahead('..'))).toEqual(['no-restricted-imports'])
    expect(await violations('src/presets/probe.ts', ahead('..'))).toEqual(['no-restricted-imports'])
  })

  it('keeps the model and the manifest apart in both directions', async () => {
    expect(await violations('src/model/probe.ts', 'import { readManifest } from \'../manifest.js\'\n\nexport const probe = readManifest\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/manifest.ts', 'import { parseModel } from \'./model/schema.js\'\n\nexport const probe = parseModel\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/model/probe.ts', 'import { detect } from \'../detect/index.js\'\n\nexport const probe = detect\n')).toEqual([])
  })

  it('confines child processes to the pnpm version probe', async () => {
    const spawn = 'import { execFileSync } from \'node:child_process\'\n\nexport const probe = execFileSync\n'
    expect(await violations('src/commands/probe.ts', spawn)).toEqual(['no-restricted-syntax'])
    expect(await violations('src/detect/package-manager.ts', spawn)).toEqual([])
  })

  it('exempts the pnpm version probe from the child-process rule alone, never from the rest of the block', async () => {
    const forms = [
      'import { createRequire } from \'node:module\'\n\nexport const probe = createRequire\n',
      'export async function probe(specifier: string) {\n  return await import(specifier)\n}\n',
      'export function probe(specifier: string) {\n  return require(specifier)\n}\n',
      'export const enum Probe { A = 1 }\n',
    ]
    for (const form of forms)
      expect(await violations('src/detect/package-manager.ts', form), form).toContain('no-restricted-syntax')
  })

  it('reports every form of loading code the CLI did not ship', async () => {
    const forms = [
      'export async function probe() {\n  return await import(\'node:child_process\')\n}\n',
      'export async function probe(specifier: string) {\n  return await import(specifier)\n}\n',
      'export function probe(specifier: string) {\n  return require(specifier)\n}\n',
      'export function probe(specifier: string) {\n  return require.resolve(specifier)\n}\n',
      'import { createRequire } from \'node:module\'\n\nexport const probe = createRequire\n',
      'export function probe(root: string) {\n  return createRequire(root)(\'eslint\')\n}\n',
    ]
    for (const form of forms)
      expect(await violations('src/commands/probe.ts', form)).toContain('no-restricted-syntax')

    expect(await violations('src/commands/probe.ts', 'export function probe(value: string) {\n  return value.trim()\n}\n')).toEqual([])
  })

  it('keeps the restrictions the block carried before restating them', async () => {
    const resolved = await eslint.calculateConfigForFile(path.join(root, 'src/commands/probe.ts'))
    const [severity, ...entries] = resolved.rules['no-restricted-syntax'] as [number, ...(string | { selector: string })[]]
    const selectors = entries.map(entry => typeof entry === 'string' ? entry : entry.selector)

    expect(severity).toBe(2)
    expect(selectors).toEqual(expect.arrayContaining([
      'TSEnumDeclaration[const=true]',
      'TSExportAssignment',
      'ImportDeclaration[source.value="node:child_process"]',
    ]))
    expect(await violations('src/commands/probe.ts', 'export const enum Probe { A = 1 }\n')).toEqual(['no-restricted-syntax'])
  })

  it('covers the doctor directory, where the untrusted repository is read', async () => {
    const dynamic = 'export const probe = async (file: string) => import(file)\n'
    expect(await violations('src/commands/doctor/projection.ts', dynamic)).toContain('no-restricted-syntax')
  })
})

describe('doctor reads a repository it does not trust through one reader', () => {
  it('reports a bare file read anywhere under doctor, so the next unguarded read cannot arrive quietly', async () => {
    const read = 'import { readFileSync } from \'node:fs\'\n\nexport const probe = readFileSync\n'
    expect(await violations('src/commands/doctor/probe.ts', read)).toEqual(['no-restricted-imports'])
    expect(await violations('src/commands/doctor/checks/probe.ts', read)).toEqual(['no-restricted-imports'])
    expect(await violations('src/commands/doctor/readings.ts', read)).toEqual([])
  })

  it('keeps the dependency boundary the block carried before restating it, because the last block replaces the whole rule', async () => {
    expect(await violations('src/commands/doctor/probe.ts', 'import { run } from \'../../cli.js\'\n\nexport const probe = run\n')).toEqual(['no-restricted-imports'])
    expect(await violations('src/commands/doctor/probe.ts', 'import { readManifest } from \'../../manifest.js\'\n\nexport const probe = readManifest\n')).toEqual([])
  })
})

describe('the frozen init record is never read as the latest state', () => {
  it('reports a bare manifest.files anywhere under src, because it omits everything sync recorded', async () => {
    const bare = 'import type { Manifest } from \'../manifest.js\'\n\nexport function probe(manifest: Manifest): string[] {\n  return Object.keys(manifest.files)\n}\n'
    expect(await violations('src/commands/probe.ts', bare)).toEqual(['no-restricted-syntax'])
    expect(await violations('src/sync/probe.ts', bare)).toEqual(['no-restricted-syntax'])
    const withoutImporting = 'export function probe(manifest: { files: Record<string, string> }): string[] {\n  return Object.keys(manifest.files)\n}\n'
    expect(await violations('src/commands/probe.ts', withoutImporting)).toEqual(['no-restricted-syntax'])
    expect(await violations('src/manifest.ts', withoutImporting)).toEqual([])
  })

  it('keeps the spawn and code-loading restrictions the block carried before this one was added to it', async () => {
    const resolved = await eslint.calculateConfigForFile(path.join(root, 'src/commands/probe.ts'))
    const [, ...entries] = resolved.rules['no-restricted-syntax'] as [number, ...(string | { selector: string })[]]
    const selectors = entries.map(entry => typeof entry === 'string' ? entry : entry.selector)
    expect(selectors).toEqual(expect.arrayContaining([
      'TSEnumDeclaration[const=true]',
      'ImportDeclaration[source.value="node:child_process"]',
      'ImportExpression',
      'MemberExpression[property.name="files"][object.name=/^(manifest|previous)$/]',
    ]))
  })
})

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const eslint = new ESLint({ cwd: root })

async function violations(file: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: path.join(root, file) })
  return result.messages.map(message => message.ruleId ?? '').filter(rule => rule === 'no-restricted-imports' || rule === 'no-restricted-syntax')
}

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
    expect(await violations('src/commands/doctor/checks/lint-policy.ts', dynamic)).toContain('no-restricted-syntax')
  })
})

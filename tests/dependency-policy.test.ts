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

  it('confines child processes to the pnpm version probe', async () => {
    const spawn = 'import { execFileSync } from \'node:child_process\'\n\nexport const probe = execFileSync\n'
    expect(await violations('src/commands/probe.ts', spawn)).toEqual(['no-restricted-syntax'])
    expect(await violations('src/detect/package-manager.ts', spawn)).toEqual([])
  })
})

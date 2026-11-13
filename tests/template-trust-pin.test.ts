import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runInit } from '../src/commands/init.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const LAST_ENCODEURL_BEFORE_THE_TRUST_DOWNGRADE = '2.0.0'

const PRESETS_THAT_INSTALL_EXPRESS = ['node-backend', 'monorepo'] as const

interface WorkspacePolicy {
  overrides?: Record<string, string>
  trustPolicy?: string
  trustPolicyExclude?: string[]
}

async function workspaceOf(preset: string): Promise<WorkspacePolicy> {
  const dir = mkdtempSync(path.join(tmpdir(), `construct-trust-${preset}-`))
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset, name: 'trust', yes: true, dryRun: false })
  return parse(readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')) as WorkspacePolicy
}

describe('a generated project installs express without trusting a downgraded encodeurl', () => {
  it.each(PRESETS_THAT_INSTALL_EXPRESS)('%s pins encodeurl to the last trusted release and keeps no-downgrade for it', async (preset) => {
    const workspace = await workspaceOf(preset)

    expect(workspace.trustPolicy).toBe('no-downgrade')
    expect(workspace.overrides?.encodeurl).toBe(LAST_ENCODEURL_BEFORE_THE_TRUST_DOWNGRADE)
    expect((workspace.trustPolicyExclude ?? []).filter(entry => entry.startsWith('encodeurl'))).toEqual([])
  })
})

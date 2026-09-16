import type { AiTarget, PresetId } from '../src/presets/index.js'
import type { Prompter } from '../src/ui/prompts.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/commands/doctor.js'
import { runInit } from '../src/commands/init.js'
import { readManifest } from '../src/manifest.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-init-'))
}

describe('construct init --yes --preset node-backend', () => {
  it('materializes the baseline, the manifest and the discovery markers into an empty directory', async () => {
    const dir = scratch()
    const result = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(result.status).toBe('done')
    for (const file of ['package.json', 'CLAUDE.md', 'AGENTS.md', 'construct.json', 'architecture/principles.md', 'architecture/composition/http.yaml', 'contracts/api/openapi.yaml', 'src/app.ts', 'src/contracts/openapi.ts', '.claude/commands/construct-discover.md', '.github/workflows/ci.yml'])
      expect(existsSync(path.join(dir, file)), file).toBe(true)

    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name: string, scripts: Record<string, string> }
    expect(pkg.name).toBe(path.basename(dir).toLowerCase())
    expect(pkg.scripts.quality).toContain('composition:check')
    expect(pkg.scripts.quality).toContain('contracts:check')

    const manifest = readManifest(dir)
    expect(manifest?.preset).toBe('node-backend')
    expect(manifest?.harness.command).toBe('pnpm run quality')
    expect(Object.keys(manifest?.files ?? {})).toContain('CLAUDE.md')

    const doctor = runDoctor(dir)
    expect(doctor?.ok).toBe(true)
    expect(doctor?.missingDiscovery).toContain('module-map')
    expect(doctor?.missingDiscovery).not.toContain('composition')
  })

  it('never overwrites existing files and merges the manifest', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'keep-me', scripts: { test: 'jest' } }))
    writeFileSync(path.join(dir, 'src.ts'), 'export {}\n')
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mine\n')
    const result = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(result.status).toBe('done')
    expect(result.conflicts).toEqual(['package.json: name', 'package.json: scripts.test'])
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name: string, scripts: Record<string, string> }
    expect(pkg.name).toBe('keep-me')
    expect(pkg.scripts.test).toBe('jest')
    expect(pkg.scripts.quality).toBeDefined()
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').startsWith('# Mine\n\n<!-- construct:begin -->')).toBe(true)
  })

  it('writes nothing on a dry run', async () => {
    const dir = scratch()
    const result = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: true })
    expect(result.status).toBe('dry-run')
    expect(existsSync(path.join(dir, 'package.json'))).toBe(false)
  })

  it('is idempotent: a second run keeps the discovered content', async () => {
    const dir = scratch()
    await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    const claude = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')
    writeFileSync(path.join(dir, 'CLAUDE.md'), claude.replace('<!-- construct:discover:module-map -->\n_Not discovered yet — run `/construct-discover`._', '<!-- construct:discover:module-map -->\n| src | everything |'))
    const second = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(second.conflicts).toEqual([])
    const again = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')
    expect(again).toContain('| src | everything |')
    expect(again.match(/construct:begin/g)).toHaveLength(1)
    expect(runDoctor(dir)?.missingDiscovery).not.toContain('module-map')
  })
})

interface Script {
  preset?: PresetId
  ai?: AiTarget
  name?: string
  confirm?: boolean
}

function scripted(script: Script): { prompter: Prompter, asked: string[] } {
  const asked: string[] = []
  const answer = <K extends keyof Script>(key: K): Promise<Script[K]> => {
    asked.push(key)
    return Promise.resolve(script[key])
  }
  return {
    asked,
    prompter: {
      preset: () => answer('preset'),
      aiTarget: () => answer('ai'),
      projectName: () => answer('name'),
      confirm: () => answer('confirm'),
    },
  }
}

describe('construct init (interactive)', () => {
  it('fills every gap from the prompts and writes on confirmation', async () => {
    const dir = scratch()
    const { prompter, asked } = scripted({ preset: 'node-backend', ai: 'both', name: 'custom-name', confirm: true })
    const result = await runInit(ui, { dir, yes: false, dryRun: false }, prompter)
    expect(result.status).toBe('done')
    expect(asked).toEqual(['preset', 'ai', 'name', 'confirm'])
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name: string }
    expect(pkg.name).toBe('custom-name')
    expect(existsSync(path.join(dir, '.cursor/rules'))).toBe(true)
    expect(readManifest(dir)?.ai).toBe('both')
  })

  it('lets flags answer questions so only the confirmation is asked', async () => {
    const dir = scratch()
    const { prompter, asked } = scripted({ confirm: true })
    const result = await runInit(ui, { dir, preset: 'node-backend', ai: 'cursor', name: 'flagged', yes: false, dryRun: false }, prompter)
    expect(result.status).toBe('done')
    expect(asked).toEqual(['confirm'])
    expect(existsSync(path.join(dir, '.claude'))).toBe(false)
  })

  it('writes nothing when the netrunner jacks out at any prompt', async () => {
    for (const script of [{}, { preset: 'node-backend' as const }, { preset: 'node-backend' as const, ai: 'claude' as const, name: 'x', confirm: false }]) {
      const dir = scratch()
      const result = await runInit(ui, { dir, yes: false, dryRun: false }, scripted(script).prompter)
      expect(result.status).toBe('aborted')
      expect(existsSync(path.join(dir, 'package.json'))).toBe(false)
    }
  })

  it('asks nothing with --yes even when a prompter is available', async () => {
    const dir = scratch()
    const { prompter, asked } = scripted({ confirm: false })
    const result = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false }, prompter)
    expect(result.status).toBe('done')
    expect(asked).toEqual([])
  })

  it('aborts without a terminal unless --yes is given', async () => {
    const dir = scratch()
    const result = await runInit(ui, { dir, preset: 'node-backend', yes: false, dryRun: false })
    expect(result.status).toBe('aborted')
    expect(existsSync(path.join(dir, 'package.json'))).toBe(false)
  })

  it('rejects an invalid --name before touching the directory', async () => {
    const dir = scratch()
    await expect(runInit(ui, { dir, preset: 'node-backend', name: 'Bad Name', yes: true, dryRun: false })).rejects.toThrow('invalid project name')
    expect(existsSync(path.join(dir, 'package.json'))).toBe(false)
  })
})

describe('construct init --preset monorepo', () => {
  it('materializes apps/api, packages/shared with the contract types, and a workspace policy', async () => {
    const dir = scratch()
    const result = await runInit(ui, { dir, preset: 'monorepo', name: 'shop', yes: true, dryRun: false })
    expect(result.status).toBe('done')
    for (const file of ['pnpm-workspace.yaml', 'apps/api/src/app.ts', 'apps/api/package.json', 'packages/shared/src/api/openapi.ts', 'packages/shared/src/index.ts', 'contracts/api/openapi.yaml', 'architecture/composition/http.yaml'])
      expect(existsSync(path.join(dir, file)), file).toBe(true)
    expect(readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('catalog:')
    expect(readFileSync(path.join(dir, 'architecture/composition/http.yaml'), 'utf8')).toContain('path: apps/api/src/app.ts')
    expect(readFileSync(path.join(dir, 'apps/api/src/contracts/types.ts'), 'utf8')).toContain('from \'@shop/shared\'')
    expect(readFileSync(path.join(dir, 'eslint.config.mjs'), 'utf8')).toContain('\'apps/api\': [\'@shop/shared\']')
    const manifest = readManifest(dir)
    expect(manifest?.contracts).toEqual({ path: 'contracts/api/openapi.yaml', types: 'packages/shared/src/api/openapi.ts' })
    expect(runDoctor(dir)?.ok).toBe(true)
  })
})

describe('construct init --preset node-frontend', () => {
  it('materializes a Vite app with CSS rules and no contract', async () => {
    const dir = scratch()
    const result = await runInit(ui, { dir, preset: 'node-frontend', yes: true, dryRun: false })
    expect(result.status).toBe('done')
    for (const file of ['index.html', 'src/main.ts', 'src/styles/tokens.css', 'tests/app.test.ts', 'architecture/composition/app.yaml', '.claude/rules/css.md'])
      expect(existsSync(path.join(dir, file)), file).toBe(true)
    expect(existsSync(path.join(dir, 'contracts'))).toBe(false)
    const claude = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')
    expect(claude).not.toContain('## Contract')
    expect(claude).not.toContain('contracts:types')
    expect(claude).toContain('Always high, whatever discovery finds: `architecture/composition/`')
    expect(readManifest(dir)?.contracts).toBeNull()
    expect(runDoctor(dir)?.ok).toBe(true)
  })
})

describe('construct init on a directory that is not empty', () => {
  it('keeps the baseline and the contract but omits the sample sources', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mine', packageManager: 'pnpm@11.0.0' }))
    const result = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(result.status).toBe('done')
    expect(existsSync(path.join(dir, 'src/app.ts'))).toBe(false)
    expect(existsSync(path.join(dir, 'architecture/composition'))).toBe(false)
    expect(existsSync(path.join(dir, 'src/contracts/openapi.ts'))).toBe(true)
    expect(existsSync(path.join(dir, 'contracts/api/openapi.yaml'))).toBe(true)
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { packageManager: string }
    expect(pkg.packageManager).toBe('pnpm@11.0.0')
    expect(runDoctor(dir)?.ok).toBe(true)
    expect(runDoctor(dir)?.missingDiscovery).toContain('composition')
  })
})

describe('construct doctor and the contract', () => {
  it('reports a missing generated types file named by the manifest', async () => {
    const dir = scratch()
    await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    rmSync(path.join(dir, 'src/contracts/openapi.ts'))
    const doctor = runDoctor(dir)
    expect(doctor?.ok).toBe(false)
    expect(doctor?.harnessProblems).toEqual(['src/contracts/openapi.ts is missing (construct.json → contracts)'])
  })
})

const GIVE_BUDDY = path.join(homedir(), 'projects/give-buddy')

describe.skipIf(!existsSync(GIVE_BUDDY))('construct init on give-buddy', () => {
  it('dry run: creates only the agent layer, merges the manifests, touches nothing else', async () => {
    const result = await runInit(ui, { dir: GIVE_BUDDY, preset: 'monorepo', yes: true, dryRun: true })
    expect(result.status).toBe('dry-run')
    expect(result.skipped).toContain('eslint.config.mjs')
    expect(result.skipped).toContain('contracts/api/openapi.yaml')
    expect(result.conflicts.every(conflict => conflict.endsWith('package.json') || conflict.includes('package.json: '))).toBe(true)
  })

  it('real init on a fresh clone leaves doctor green', async () => {
    const dir = scratch()
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${GIVE_BUDDY}`, dir], { stdio: 'ignore' })
    const before = new Set(readdirSync(dir, { recursive: true }) as string[])
    const result = await runInit(ui, { dir, preset: 'monorepo', yes: true, dryRun: false })
    expect(result.status).toBe('done')
    const created = result.written.filter(file => !before.has(file))
    expect(created.every(file => file.startsWith('.claude/') || file.startsWith('architecture/') || file === 'construct.json')).toBe(true)
    const rewritten = result.written.filter(file => before.has(file))
    expect(rewritten.sort()).toEqual(['.gitignore', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'packages/shared/package.json'])
    const doctor = runDoctor(dir)
    expect(doctor?.ok).toBe(true)
    expect(doctor?.harnessProblems).toEqual([])
  })
})

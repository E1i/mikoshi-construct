import type { AiTarget, PresetId } from '../src/presets/index.js'
import type { Prompter } from '../src/ui/prompts.js'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/commands/doctor/index.js'
import { runInit } from '../src/commands/init.js'
import { readManifest } from '../src/manifest.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { manifestResult } from './doctor-manifest-result.js'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-init-'))
}

describe('construct init --yes --preset node-backend', () => {
  it('materializes the baseline, the manifest and the discovery markers into an empty directory', async () => {
    const dir = scratch()
    const result = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(result.status).toBe('done')
    for (const file of ['package.json', 'CLAUDE.md', 'AGENTS.md', 'construct.json', 'architecture/principles.md', 'architecture/decisions/README.md', 'architecture/composition/http.yaml', 'contracts/api/openapi.yaml', 'src/app.ts', 'src/contracts/openapi.ts', 'scripts/tests/lint/syntax-policy.test.ts', '.claude/commands/construct-discover.md', '.github/workflows/ci.yml'])
      expect(existsSync(path.join(dir, file)), file).toBe(true)

    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name: string, scripts: Record<string, string> }
    expect(pkg.name).toBe(path.basename(dir).toLowerCase())
    expect(pkg.scripts.quality).toContain('composition:check')
    expect(pkg.scripts.quality).toContain('contracts:check')

    const manifest = readManifest(dir)
    expect(manifest?.preset).toBe('node-backend')
    expect(manifest?.harness.command).toBe('pnpm run quality')
    expect(Object.keys(manifest?.files ?? {})).toContain('CLAUDE.md')
    expect(manifest?.files['architecture/decisions/README.md']).toMatch(/^[0-9a-f]{8,}$/)

    const doctor = manifestResult(runDoctor(dir))
    expect(doctor?.ok).toBe(true)
    expect(doctor?.missingDiscovery).toContain('module-map')
    expect(doctor?.missingDiscovery).not.toContain('composition')
  })

  it('gives the generated project documents that are what the templates promise, not merely files that exist', async () => {
    const dir = scratch()
    await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false, name: 'demo-service' })

    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const lines = readFileSync(path.join(dir, file), 'utf8').split('\n')
      const heading = lines.find(line => line.trim() !== '' && !line.startsWith('<!--'))
      expect(heading, file).toBe('# demo-service')
    }
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
    const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
    writeFileSync(path.join(dir, 'AGENTS.md'), agents.replace('<!-- construct:discover:module-map -->\n_Not discovered yet — run `/construct-discover`._', '<!-- construct:discover:module-map -->\n| src | everything |'))
    const second = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(second.conflicts).toEqual([])
    const again = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
    expect(again).toContain('| src | everything |')
    expect(again.match(/construct:begin/g)).toHaveLength(1)
    expect(manifestResult(runDoctor(dir))?.missingDiscovery).not.toContain('module-map')
  })
})

interface Script {
  preset?: PresetId
  ai?: AiTarget
  name?: string
  review?: boolean
  lanes?: number
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
      review: () => answer('review'),
      lanes: () => answer('lanes'),
      confirm: () => answer('confirm'),
      harnessCommand: () => Promise.resolve(null),
    },
  }
}

describe('construct init (interactive)', () => {
  it('fills every gap from the prompts and writes on confirmation', async () => {
    const dir = scratch()
    const { prompter, asked } = scripted({ preset: 'node-backend', ai: 'both', name: 'custom-name', review: true, lanes: 4, confirm: true })
    const result = await runInit(ui, { dir, yes: false, dryRun: false }, prompter)
    expect(result.status).toBe('done')
    expect(asked).toEqual(['preset', 'ai', 'name', 'review', 'lanes', 'confirm'])
    expect(readManifest(dir)?.lanes).toBe(4)
    expect(existsSync(path.join(dir, '.github/workflows/claude-review.yml'))).toBe(true)
    expect(readManifest(dir)?.review).toEqual({ provider: 'claude', model: 'claude-sonnet-5' })
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name: string }
    expect(pkg.name).toBe('custom-name')
    expect(existsSync(path.join(dir, '.cursor/rules'))).toBe(true)
    expect(readManifest(dir)?.ai).toBe('both')
  })

  it('asks nothing the construct.json already answers, leaving only the confirmation that authorises the write', async () => {
    const dir = scratch()
    const first = scripted({ preset: 'node-backend', ai: 'both', name: 'custom-name', review: true, lanes: 5, confirm: true })
    await runInit(ui, { dir, yes: false, dryRun: false }, first.prompter)
    expect(first.asked).toEqual(['preset', 'ai', 'name', 'review', 'lanes', 'confirm'])

    const lines: string[] = []
    const second = scripted({ confirm: true })
    const result = await runInit(createUi(resolveTheme({ plain: true }), line => lines.push(line)), { dir, yes: false, dryRun: false }, second.prompter)

    expect(result.status).toBe('done')
    expect(second.asked).toEqual(['confirm'])
    const manifest = readManifest(dir)
    expect(manifest?.preset).toBe('node-backend')
    expect(manifest?.ai).toBe('both')
    expect(manifest?.vars.projectName).toBe('custom-name')
    expect(manifest?.review).toEqual({ provider: 'claude', model: 'claude-sonnet-5' })
    expect(manifest?.lanes).toBe(5)
    expect(lines.join('')).toContain('came from the construct.json already here')
  })

  it('lets a flag override what the record answers, and records the value the flag named', async () => {
    const dir = scratch()
    await runInit(ui, { dir, preset: 'node-backend', ai: 'claude', name: 'first-name', review: 'none', yes: true, dryRun: false })

    const { prompter, asked } = scripted({ confirm: true })
    await runInit(ui, { dir, name: 'renamed', yes: false, dryRun: false }, prompter)

    expect(asked).toEqual(['confirm'])
    expect(readManifest(dir)?.vars.projectName).toBe('renamed')
    expect(readManifest(dir)?.ai).toBe('claude')
  })

  it('lets flags answer questions so only the confirmation is asked', async () => {
    const dir = scratch()
    const { prompter, asked } = scripted({ confirm: true })
    const result = await runInit(ui, { dir, preset: 'node-backend', ai: 'cursor', name: 'flagged', review: 'none', lanes: '2', yes: false, dryRun: false }, prompter)
    expect(result.status).toBe('done')
    expect(asked).toEqual(['confirm'])
    expect(existsSync(path.join(dir, '.claude'))).toBe(false)
  })

  it('writes nothing when the netrunner jacks out at any prompt', async () => {
    for (const script of [{}, { preset: 'node-backend' as const }, { preset: 'node-backend' as const, ai: 'claude' as const, name: 'x', review: false, lanes: 3, confirm: false }]) {
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
    for (const file of ['pnpm-workspace.yaml', 'apps/api/src/app.ts', 'apps/api/package.json', 'packages/shared/src/api/openapi.ts', 'packages/shared/src/index.ts', 'contracts/api/openapi.yaml', 'architecture/composition/http.yaml', 'scripts/tests/lint/syntax-policy.test.ts'])
      expect(existsSync(path.join(dir, file)), file).toBe(true)
    expect(readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('catalog:')
    expect(readFileSync(path.join(dir, 'architecture/composition/http.yaml'), 'utf8')).toContain('path: apps/api/src/app.ts')
    expect(readFileSync(path.join(dir, 'apps/api/src/contracts/types.ts'), 'utf8')).toContain('from \'@shop/shared\'')
    expect(readFileSync(path.join(dir, 'eslint.config.mjs'), 'utf8')).toContain('\'apps/api\': [\'@shop/shared\']')
    const manifest = readManifest(dir)
    expect(manifest?.contracts).toEqual({ path: 'contracts/api/openapi.yaml', types: 'packages/shared/src/api/openapi.ts' })
    expect(manifestResult(runDoctor(dir))?.ok).toBe(true)
  })
})

describe('construct init --preset node-frontend', () => {
  it('materializes a Vite app with CSS rules and no contract', async () => {
    const dir = scratch()
    const result = await runInit(ui, { dir, preset: 'node-frontend', yes: true, dryRun: false })
    expect(result.status).toBe('done')
    for (const file of ['index.html', 'src/main.ts', 'src/styles/tokens.css', 'tests/app.test.ts', 'architecture/composition/app.yaml', '.claude/rules/css.md', 'scripts/tests/lint/syntax-policy.test.ts'])
      expect(existsSync(path.join(dir, file)), file).toBe(true)
    expect(existsSync(path.join(dir, 'contracts'))).toBe(false)
    const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
    expect(agents).not.toContain('## Contract')
    expect(agents).not.toContain('contracts:types')
    expect(agents).toContain('Always high, whatever discovery finds: `architecture/composition/`')
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md')
    expect(readManifest(dir)?.contracts).toBeNull()
    expect(manifestResult(runDoctor(dir))?.ok).toBe(true)
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
    expect(existsSync(path.join(dir, 'scripts/tests/lint/syntax-policy.test.ts'))).toBe(false)
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { packageManager: string }
    expect(pkg.packageManager).toBe('pnpm@11.0.0')
    expect(manifestResult(runDoctor(dir))?.ok).toBe(true)
    expect(manifestResult(runDoctor(dir))?.missingDiscovery).toContain('composition')
  })
})

describe('construct doctor and the contract', () => {
  it('reports a missing generated types file named by the manifest', async () => {
    const dir = scratch()
    await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    rmSync(path.join(dir, 'src/contracts/openapi.ts'))
    const doctor = manifestResult(runDoctor(dir))
    expect(doctor?.ok).toBe(false)
    expect(doctor?.harnessProblems).toEqual(['src/contracts/openapi.ts is missing (construct.json → contracts)'])
  })
})

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')

describe('construct init on an existing monorepo', () => {
  it('dry run: creates only the agent layer, merges the manifests, touches nothing else', async () => {
    const result = await runInit(ui, { dir: EXISTING_MONOREPO, preset: 'monorepo', yes: true, dryRun: true })
    expect(result.status).toBe('dry-run')
    expect(result.skipped).toContain('eslint.config.mjs')
    expect(result.skipped).toContain('contracts/api/openapi.yaml')
    expect(result.conflicts.every(conflict => conflict.endsWith('package.json') || conflict.includes('package.json: '))).toBe(true)
  })

  it('real init on a copy leaves doctor green and the repository\'s own files alone', async () => {
    const dir = scratch()
    cpSync(EXISTING_MONOREPO, dir, { recursive: true })
    const before = new Set(readdirSync(dir, { recursive: true }) as string[])
    const result = await runInit(ui, { dir, preset: 'monorepo', yes: true, dryRun: false })
    expect(result.status).toBe('done')
    const created = result.written.filter(file => !before.has(file))
    expect(created.every(file => file.startsWith('.claude/') || file.startsWith('architecture/') || file.startsWith('scripts/construct/') || file === 'construct.json')).toBe(true)
    expect(created).not.toContain('scripts/tests/lint/syntax-policy.test.ts')
    const rewritten = result.written.filter(file => before.has(file))
    expect(rewritten.sort()).toEqual(['.gitignore', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'packages/shared/package.json'])
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').startsWith('# example-monorepo\n')).toBe(true)
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe('1.4.0')
    const doctor = manifestResult(runDoctor(dir))
    expect(doctor?.ok).toBe(true)
    expect(doctor?.harnessProblems).toEqual([])
  })
})

describe('construct init --ai cursor', () => {
  it('renders the same rules as .mdc and writes nothing under .claude', async () => {
    const dir = scratch()
    const result = await runInit(ui, { dir, preset: 'node-frontend', ai: 'cursor', yes: true, dryRun: false })
    expect(result.status).toBe('done')
    expect(existsSync(path.join(dir, '.claude'))).toBe(false)
    expect(readFileSync(path.join(dir, '.cursor/rules/conventions.mdc'), 'utf8').startsWith('---\ndescription: Code conventions\nalwaysApply: true\n---\n')).toBe(true)
    expect(readFileSync(path.join(dir, '.cursor/rules/css.mdc'), 'utf8')).toContain('globs: **/*.css, **/*.vue, **/*.astro\nalwaysApply: false')
    expect(existsSync(path.join(dir, '.cursor/rules/construct.mdc'))).toBe(true)
  })

  it('writes both formats for --ai both', async () => {
    const dir = scratch()
    await runInit(ui, { dir, preset: 'node-backend', ai: 'both', yes: true, dryRun: false })
    for (const file of ['.claude/rules/tests.md', '.cursor/rules/tests.mdc', '.claude/rules/secrets.md', '.cursor/rules/secrets.mdc'])
      expect(existsSync(path.join(dir, file)), file).toBe(true)
  })
})

describe('construct init --review', () => {
  it('adds the label-triggered Claude review workflow with the chosen model, and nothing without it', async () => {
    const dir = scratch()
    await runInit(ui, { dir, preset: 'node-backend', review: 'claude', reviewModel: 'claude-opus-5', yes: true, dryRun: false })
    const workflow = readFileSync(path.join(dir, '.github/workflows/claude-review.yml'), 'utf8')
    expect(workflow).toContain('--model claude-opus-5')
    expect(workflow).toContain('CODE_REVIEW_API_KEY')
    expect(readManifest(dir)?.review).toEqual({ provider: 'claude', model: 'claude-opus-5' })

    const plain = scratch()
    await runInit(ui, { dir: plain, preset: 'node-backend', yes: true, dryRun: false })
    expect(existsSync(path.join(plain, '.github/workflows/claude-review.yml'))).toBe(false)
    expect(readManifest(plain)?.review).toBeNull()
  })
})

describe('the discovery protocol', () => {
  it('ships as a Claude command and as an agent-requested Cursor rule, from one source', async () => {
    const dir = scratch()
    await runInit(ui, { dir, preset: 'node-backend', ai: 'both', yes: true, dryRun: false })
    const command = readFileSync(path.join(dir, '.claude/commands/construct-discover.md'), 'utf8')
    const rule = readFileSync(path.join(dir, '.cursor/rules/construct-discover.mdc'), 'utf8')
    expect(command).toContain('$ARGUMENTS')
    expect(rule.startsWith('---\ndescription: Discover this repository')).toBe(true)
    expect(rule).toContain('alwaysApply: false')
    expect(rule).not.toContain('$ARGUMENTS')
    expect(rule).toContain('13. **Prove it.**')
    expect(rule).toContain('12. **Write what you concluded, into the model.**')
    expect(existsSync(path.join(dir, 'architecture/checklists.md'))).toBe(true)
  })
})

describe('construct init on a repository that already documents itself', () => {
  it('appends the existing-file variant without a second H1, keeps composition models where they are and adds no version', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mine', private: true, scripts: { test: 'vitest run' } }))
    writeFileSync(path.join(dir, 'AGENTS.md'), '# Mine\n\n## Real defects vs accepted variance\n\n- ours\n')
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mine\n\nHand-written.\n')
    mkdirSync(path.join(dir, 'docs/architecture/composition'), { recursive: true })
    writeFileSync(path.join(dir, 'docs/architecture/composition/app.yaml'), 'id: app\n')
    mkdirSync(path.join(dir, 'src'))
    const result = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(result.status).toBe('done')

    const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
    expect(agents.match(/^# /gm)).toHaveLength(1)
    expect(agents).toContain('## Construct')
    expect(agents).not.toContain('## Module map')
    expect(agents).toContain('<!-- construct:discover:high-effort-areas -->')
    expect(agents).toContain('docs/architecture/composition/')
    const claude = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')
    expect(claude.match(/^# /gm)).toHaveLength(1)
    expect(claude).not.toContain('@AGENTS.md')
    expect(claude).toContain('/construct-discover')

    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg.version).toBeUndefined()
    expect(Object.keys(pkg).indexOf('scripts')).toBeGreaterThan(Object.keys(pkg).indexOf('private'))

    const manifest = readManifest(dir)
    expect(manifest?.discovery.markers.composition.file).toBe('docs/architecture/composition')
    expect(existsSync(path.join(dir, 'architecture/composition'))).toBe(false)
    expect(manifestResult(runDoctor(dir))?.missingDiscovery).not.toContain('composition')
  })
})

const WINDOW_HOOK = 'scripts/construct/window-hooks.mjs'
const SETTINGS = '.claude/settings.json'

interface HookSettings { hooks: Record<string, { matcher?: string, hooks: { type: string, command: string, timeout?: number }[] }[]> }

function readSettingsOf(dir: string): HookSettings {
  return JSON.parse(readFileSync(path.join(dir, SETTINGS), 'utf8')) as HookSettings
}

function windowCommand(event: string): string {
  return `node "$CLAUDE_PROJECT_DIR"/${WINDOW_HOOK} ${event} --needs-construct`
}

function commandsOf(settings: HookSettings, event: string): string[] {
  return (settings.hooks[event] ?? []).flatMap(entry => entry.hooks.map(hook => hook.command))
}

function runWindowHook(dir: string, event: string, pathDirs: string[], handoff: string): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [path.join(dir, WINDOW_HOOK), event, '--needs-construct'], {
    input: '{}',
    encoding: 'utf8',
    env: { PATH: pathDirs.join(path.delimiter), HOME: dir, CONSTRUCT_HANDOFF: handoff },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('construct init and the tab-window hooks', () => {
  it('init writes the Stop, PreCompact and SessionStart compact window hooks into a tracked .claude/settings.json', async () => {
    const dir = scratch()
    const result = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(result.written).toEqual(expect.arrayContaining([SETTINGS, WINDOW_HOOK]))
    const settings = readSettingsOf(dir)
    expect(commandsOf(settings, 'Stop')).toEqual([windowCommand('stop')])
    expect(commandsOf(settings, 'PreCompact')).toEqual([windowCommand('pre-compact')])
    expect(commandsOf(settings, 'SessionStart')).toEqual([windowCommand('session-start')])
    expect(settings.hooks.SessionStart?.[0]?.matcher).toBe('compact')
    expect(readManifest(dir)?.files[SETTINGS]).toMatch(/^[0-9a-f]{8,}$/)
    expect(readManifest(dir)?.files[WINDOW_HOOK]).toMatch(/^[0-9a-f]{8,}$/)
    const ignored = readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n')
    for (const pattern of ['.claude', '.claude/', SETTINGS, 'scripts', 'scripts/', 'scripts/construct/'])
      expect(ignored, pattern).not.toContain(pattern)
  })

  it('init into a repository with its own .claude/settings.json keeps its hooks and adds the window hooks', async () => {
    const dir = scratch()
    const own = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo own-stop' }] }], PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo own-post' }] }] } }
    mkdirSync(path.join(dir, '.claude'))
    writeFileSync(path.join(dir, SETTINGS), `${JSON.stringify(own, null, 2)}\n`)
    const result = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(result.written).toContain(SETTINGS)
    expect(result.skipped).not.toContain(SETTINGS)
    const settings = readSettingsOf(dir) as HookSettings & { permissions: unknown }
    expect(settings.permissions).toEqual(own.permissions)
    expect(commandsOf(settings, 'Stop')).toEqual(['echo own-stop', windowCommand('stop')])
    expect(commandsOf(settings, 'PostToolUse')).toEqual(['echo own-post', 'node "$CLAUDE_PROJECT_DIR"/scripts/construct/window-heartbeat.mjs'])
    expect(commandsOf(settings, 'PreCompact')).toEqual([windowCommand('pre-compact')])
    expect(commandsOf(settings, 'SessionStart')).toEqual([windowCommand('session-start')])

    await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(commandsOf(readSettingsOf(dir), 'Stop')).toEqual(['echo own-stop', windowCommand('stop')])
  })

  it('init leaves a .claude/settings.json it cannot read as hook settings untouched', async () => {
    const dir = scratch()
    mkdirSync(path.join(dir, '.claude'))
    writeFileSync(path.join(dir, SETTINGS), '{ "hooks": [] }\n')
    const result = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(result.skipped).toContain(SETTINGS)
    expect(readFileSync(path.join(dir, SETTINGS), 'utf8')).toBe('{ "hooks": [] }\n')
  })

  it('the tracked window hook with no construct on PATH prints one stderr line and does nothing', async () => {
    const dir = scratch()
    await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    const handoff = path.join(dir, 'miko.md')
    writeFileSync(handoff, 'STATUS: CONTINUE\n')
    const empty = mkdtempSync(path.join(tmpdir(), 'construct-no-bin-'))

    const without = runWindowHook(dir, 'stop', [empty], handoff)
    expect(without.status).toBe(0)
    expect(without.stdout).toBe('')
    expect(without.stderr.trimEnd().split('\n')).toHaveLength(1)
    expect(without.stderr).toContain('construct is not on PATH')

    const bin = mkdtempSync(path.join(tmpdir(), 'construct-bin-'))
    writeFileSync(path.join(bin, 'construct'), '#!/bin/sh\nexit 0\n')
    chmodSync(path.join(bin, 'construct'), 0o755)
    const withConstruct = runWindowHook(dir, 'stop', [empty, bin], handoff)
    expect(withConstruct.status).toBe(0)
    expect(withConstruct.stderr).toBe('')
    expect(JSON.parse(withConstruct.stdout)).toMatchObject({ decision: 'block' })
  })

  it('ships the init window hook as the byte twin of the attach window hook', () => {
    const templates = path.join(import.meta.dirname, '../templates')
    expect(readFileSync(path.join(templates, 'ai/claude', WINDOW_HOOK), 'utf8')).toBe(readFileSync(path.join(templates, 'attach/_construct/window-hooks.mjs'), 'utf8'))
  })
})

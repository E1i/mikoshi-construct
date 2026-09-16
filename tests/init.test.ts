import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

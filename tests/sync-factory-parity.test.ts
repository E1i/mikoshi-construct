import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { applySync, runSync } from '../src/commands/sync/index.js'
import { readManifest, writeManifest } from '../src/manifest.js'
import { FACTORY_MANIFEST } from '../src/materialize/factory-manifest.js'
import { carriesHookSettings } from '../src/materialize/strategies.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const SETTINGS = '.claude/settings.json'
const OWN_SETTINGS = `${JSON.stringify({ permissions: { allow: ['Bash(make test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'make notify' }] }] } }, null, 2)}\n`

async function initialised(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-sync-factory-'))
  mkdirSync(path.join(dir, '.git'))
  const ui = createUi(resolveTheme({ plain: true }), silentWriter)
  await runInit(ui, { dir, preset: 'node-backend', ai: 'claude', yes: true, dryRun: false, env: {}, home: mkdtempSync(path.join(tmpdir(), 'construct-home-')) })
  return dir
}

function asIfInitialisedBeforeTheFactory(dir: string, settings: string): void {
  const manifest = readManifest(dir)!
  const files = { ...manifest.files }
  for (const target of FACTORY_MANIFEST) {
    rmSync(path.join(dir, target), { force: true })
    delete files[target]
  }
  writeFileSync(path.join(dir, SETTINGS), settings)
  writeManifest(dir, { ...manifest, files })
}

function factoryFilesAbsent(dir: string): string[] {
  return FACTORY_MANIFEST.filter(target => !existsSync(path.join(dir, target)))
}

function produced(): string {
  return readFileSync(path.resolve(import.meta.dirname, '../templates/ai/claude/_claude/settings.json'), 'utf8')
}

describe('a repository initialised before the factory catches up with one sync --apply', () => {
  it('writes every file the factory manifest lists and merges the factory hooks into its own settings', async () => {
    const dir = await initialised()
    asIfInitialisedBeforeTheFactory(dir, OWN_SETTINGS)
    expect(factoryFilesAbsent(dir)).toEqual(FACTORY_MANIFEST.filter(target => target !== SETTINGS))
    expect(runSync(dir, VERSION)!.classifications.find(entry => entry.target === SETTINGS)?.class).toBe('update')

    applySync(dir, VERSION)

    expect(factoryFilesAbsent(dir)).toEqual([])
    const settings = readFileSync(path.join(dir, SETTINGS), 'utf8')
    expect(carriesHookSettings(settings, produced())).toBe(true)
    expect(JSON.stringify(JSON.parse(settings))).toContain('make notify')
    expect(JSON.stringify(JSON.parse(settings))).toContain('Bash(make test)')
    expect(runSync(dir, VERSION)!.classifications.find(entry => entry.target === SETTINGS)?.class).toBe('keep')
  })

  it('leaves settings it cannot merge byte for byte and still writes the rest', async () => {
    const dir = await initialised()
    asIfInitialisedBeforeTheFactory(dir, '{ "hooks": [] }\n')

    const result = applySync(dir, VERSION)!

    expect(result.refused.map(entry => entry.target)).not.toContain(SETTINGS)
    expect(result.report.classifications.find(entry => entry.target === SETTINGS)?.class).toBe('conflict')
    expect(readFileSync(path.join(dir, SETTINGS), 'utf8')).toBe('{ "hooks": [] }\n')
    expect(factoryFilesAbsent(dir)).toEqual([])
  })
})

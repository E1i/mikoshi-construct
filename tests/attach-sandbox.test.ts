import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAttach, SETTINGS_FILE } from '../src/commands/attach/index.js'
import { BROWSER_LAB_EXCLUDED_COMMAND } from '../src/commands/attach/settings.js'
import { runDetach } from '../src/commands/detach/index.js'
import { runInit } from '../src/commands/init.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const ui = createUi(resolveTheme({ plain: true }), silentWriter)
useIsolatedHome()

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-sandbox-'))
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return dir
}

function excludedOf(dir: string): string[] {
  const settings = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as { sandbox?: { excludedCommands?: string[] } }
  return settings.sandbox?.excludedCommands ?? []
}

async function attach(dir: string): Promise<void> {
  expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
}

describe('attach excludes the browser-lab command from the sandbox', () => {
  it('writes exactly one excludedCommands entry, for browser-lab.mjs', async () => {
    const dir = fixture()
    await attach(dir)
    expect(excludedOf(dir)).toEqual([BROWSER_LAB_EXCLUDED_COMMAND])
    expect(BROWSER_LAB_EXCLUDED_COMMAND).toContain('scripts/construct/browser-lab.mjs')
  })

  it('returns a settings.local.json that did not exist to not existing', async () => {
    const dir = fixture()
    await attach(dir)
    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(() => readFileSync(path.join(dir, SETTINGS_FILE))).toThrow()
  })

  it('returns a settings.local.json that existed to its bytes', async () => {
    const dir = fixture()
    const original = `${JSON.stringify({ model: 'opus', sandbox: { enabled: true } })}\n`
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), original)
    await attach(dir)
    expect(excludedOf(dir)).toEqual([BROWSER_LAB_EXCLUDED_COMMAND])
    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(original)
  })

  it('keeps an excludedCommands entry held before attach through detach', async () => {
    const dir = fixture()
    const held = { sandbox: { excludedCommands: ['docker *'] } }
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(held))
    await attach(dir)
    expect(excludedOf(dir)).toEqual(['docker *', BROWSER_LAB_EXCLUDED_COMMAND])
    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual(held)
  })

  it('neither adds nor removes the browser-lab entry the repository already held', async () => {
    const dir = fixture()
    const held = { sandbox: { excludedCommands: [BROWSER_LAB_EXCLUDED_COMMAND] } }
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(held))
    await attach(dir)
    expect(excludedOf(dir)).toEqual([BROWSER_LAB_EXCLUDED_COMMAND])
    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual(held)
  })
})

describe('init carries the same exclusion', () => {
  it('writes the entry into .claude/settings.json of an empty directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-init-sandbox-'))
    await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    const settings = JSON.parse(readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')) as { sandbox: { excludedCommands: string[] } }
    expect(settings.sandbox.excludedCommands).toEqual([BROWSER_LAB_EXCLUDED_COMMAND])
  })
})

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAttach, SETTINGS_FILE } from '../src/commands/attach/index.js'
import { ATTACH_RECORD_FILE } from '../src/commands/attach/record.js'
import { BROWSER_LAB_EXCLUDED_COMMAND, isSettingsHook, readSettings } from '../src/commands/attach/settings.js'
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

function capturedUi(): { lines: string[], ui: ReturnType<typeof createUi> } {
  const lines: string[] = []
  return { lines, ui: createUi(resolveTheme({ plain: true }), line => lines.push(line)) }
}

function existingRepositoryWithSettings(settings: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-init-existing-'))
  mkdirSync(path.join(dir, '.claude'))
  writeFileSync(path.join(dir, '.claude/settings.json'), settings)
  return dir
}

describe('init names that the organ runs without the exclusion', () => {
  it('prints the line when .claude/settings.json is skipped', async () => {
    const dir = existingRepositoryWithSettings('{ "hooks": [] }\n')
    const captured = capturedUi()
    const result = await runInit(captured.ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(result.skipped).toContain('.claude/settings.json')
    expect(captured.lines.join('\n')).toContain('runs inside the sandbox without its exclusion')
  })

  it('prints the line when .claude/settings.json is merged and loses the sandbox key', async () => {
    const dir = existingRepositoryWithSettings(`${JSON.stringify({ hooks: {} })}\n`)
    const captured = capturedUi()
    const result = await runInit(captured.ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(result.written).toContain('.claude/settings.json')
    expect(captured.lines.join('\n')).toContain('runs inside the sandbox without its exclusion')
  })

  it('prints nothing about it when init writes the entry', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-init-sandbox-'))
    const captured = capturedUi()
    await runInit(captured.ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(captured.lines.join('\n')).not.toContain('without its exclusion')
  })
})

describe('attach refuses a settings.local.json whose sandbox it cannot extend', () => {
  function readingOf(settings: unknown): string {
    const dir = fixture()
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(settings))
    return readSettings(dir).kind
  }

  it('reads a non-object sandbox as unreadable', () => {
    expect(readingOf({ sandbox: 'on' })).toBe('unreadable')
  })

  it('reads a non-array excludedCommands as unreadable', () => {
    expect(readingOf({ sandbox: { excludedCommands: 'docker *' } })).toBe('unreadable')
  })

  it('reads an object sandbox with an array excludedCommands as read', () => {
    expect(readingOf({ sandbox: { excludedCommands: [] } })).toBe('read')
  })
})

describe('a hand-edited sandbox record in the attach record', () => {
  async function recordedHook(): Promise<Record<string, unknown>> {
    const dir = fixture()
    await attach(dir)
    const record = JSON.parse(readFileSync(path.join(dir, ATTACH_RECORD_FILE), 'utf8')) as { settingsHook: Record<string, unknown> }
    return record.settingsHook
  }

  it('is accepted as recorded', async () => {
    expect(isSettingsHook(await recordedHook())).toBe(true)
  })

  it('is rejected when it names a command other than browser-lab', async () => {
    const hook = await recordedHook()
    expect(isSettingsHook({ ...hook, sandbox: { added: ['rm -rf *'], createdSandbox: true, createdExcluded: true } })).toBe(false)
  })

  it('is rejected when a flag is not a boolean', async () => {
    const hook = await recordedHook()
    expect(isSettingsHook({ ...hook, sandbox: { added: [], createdSandbox: 'yes', createdExcluded: true } })).toBe(false)
  })
})

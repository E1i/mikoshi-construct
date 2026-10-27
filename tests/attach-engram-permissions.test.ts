import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATTACH_RECORD_FILE, runAttach, SETTINGS_FILE } from '../src/commands/attach/index.js'
import { engramRules } from '../src/commands/attach/settings.js'
import { runDetach } from '../src/commands/detach/index.js'
import { engramFile } from '../src/model/discovery.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const home = useIsolatedHome()

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-engram-permissions-'))
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return dir
}

function allowOf(dir: string): string[] {
  const settings = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as { permissions?: { allow?: string[] } }
  return settings.permissions?.allow ?? []
}

function rewriteSettingsHook(dir: string, change: (hook: Record<string, unknown>) => void): void {
  const file = path.join(dir, ATTACH_RECORD_FILE)
  const record = JSON.parse(readFileSync(file, 'utf8')) as { settingsHook: Record<string, unknown> }
  change(record.settingsHook)
  writeFileSync(file, JSON.stringify(record))
}

function dropOriginalCopy(dir: string): void {
  rewriteSettingsHook(dir, (hook) => {
    delete hook.original
  })
}

describe('attach allows the repository\'s own Engram directory', () => {
  it('adds Read, Edit and Write on exactly that directory, and detach removes them', async () => {
    const dir = fixture()
    const engramDirectory = path.dirname(engramFile(dir, { attached: true, home: home() }))

    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')

    expect(allowOf(dir)).toEqual(['Read', 'Edit', 'Write'].map(tool => `${tool}(/${engramDirectory}/**)`))
    expect(allowOf(dir)).toEqual(engramRules(dir, home()))

    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(() => readFileSync(path.join(dir, SETTINGS_FILE))).toThrow()
  })

  it('keeps every rule the owner already had through attach and detach', async () => {
    const dir = fixture()
    const owner = { permissions: { allow: ['Bash(ls)'], deny: ['Read(./.env)'] }, model: 'opus' }
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(owner))

    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    expect(allowOf(dir)).toHaveLength(4)
    expect(allowOf(dir)[0]).toBe('Bash(ls)')

    expect(runDetach(ui, { dir }).status).toBe('done')
    const after = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as unknown
    expect(after).toEqual(owner)
  })

  it('does not duplicate an Engram rule the owner already allowed, and detach leaves it in place', async () => {
    const dir = fixture()
    const [alreadyAllowed, ...missing] = engramRules(dir, home())
    const owner = { permissions: { allow: ['Bash(ls)', alreadyAllowed] } }
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(owner))

    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    expect(allowOf(dir)).toEqual(['Bash(ls)', alreadyAllowed, ...missing])
    dropOriginalCopy(dir)

    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(allowOf(dir)).toEqual(owner.permissions.allow)
  })

  it('keeps all three Engram rules the owner already allowed through attach and detach', async () => {
    const dir = fixture()
    const owner = { permissions: { allow: engramRules(dir, home()) } }
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(owner))

    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    expect(allowOf(dir)).toEqual(owner.permissions.allow)
    dropOriginalCopy(dir)

    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(allowOf(dir)).toEqual(owner.permissions.allow)
  })

  it('detach deletes the allow it created and keeps the owner\'s permissions.deny', async () => {
    const dir = fixture()
    const owner = { permissions: { deny: ['Read(./.env)'] } }
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(owner))

    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    expect(allowOf(dir)).toHaveLength(3)
    dropOriginalCopy(dir)

    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual(owner)
  })

  it('detach deletes the permissions it created and keeps the rest of the owner\'s settings', async () => {
    const dir = fixture()
    const owner = { model: 'opus' }
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(owner))

    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    expect(allowOf(dir)).toHaveLength(3)
    dropOriginalCopy(dir)

    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual(owner)
  })

  it.each([
    ['an empty permissions.allow', { permissions: { allow: [] } }],
    ['an empty permissions', { permissions: {} }],
  ])('detach restores exactly the owner\'s settings that start with %s', async (_name, owner) => {
    const dir = fixture()
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(owner))

    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    expect(allowOf(dir)).toHaveLength(3)
    dropOriginalCopy(dir)

    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual(owner)
  })

  it('detaches a record written before settingsHook.engram existed', async () => {
    const dir = fixture()
    const owner = { model: 'opus' }
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(owner))
    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    rewriteSettingsHook(dir, (hook) => {
      delete hook.original
      delete hook.engram
    })

    expect(runDetach(ui, { dir }).status).toBe('done')
    const after = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as { hooks?: unknown, model: string }
    expect(after.model).toBe('opus')
    expect(after.hooks).toBeUndefined()
    expect(allowOf(dir)).toEqual(engramRules(dir, home()))
    expect(existsSync(path.join(dir, ATTACH_RECORD_FILE))).toBe(false)
  })

  it.each([
    ['a permissions that is not an object', { permissions: [] }],
    ['a permissions.allow that is not a list', { permissions: { allow: {} } }],
  ])('attach refuses settings with %s and writes nothing', async (_name, content) => {
    const dir = fixture()
    const before = JSON.stringify(content)
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), before)

    const result = await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })

    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('settings-unreadable')
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(before)
    expect(existsSync(path.join(dir, '.construct'))).toBe(false)
  })
})

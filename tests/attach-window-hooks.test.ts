import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { readAttachRecord, runAttach, SETTINGS_FILE } from '../src/commands/attach/index.js'
import { engramRules, WINDOW_ENTRIES, WINDOW_EVENTS } from '../src/commands/attach/settings.js'
import { runDetach } from '../src/commands/detach/index.js'
import { ATTACH_GUARD, ATTACH_WINDOW_HOOKS } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const TEMPLATE = path.join(import.meta.dirname, '../templates/attach/_construct/window-hooks.mjs')
const HARNESS = 'pnpm run quality'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const home = useIsolatedHome()

const GUARD_ENTRY = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR"/${ATTACH_GUARD.target}`, timeout: 30 }],
}

function windowEntry(argument: string, matcher?: string): Record<string, unknown> {
  const hooks = [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR"/${ATTACH_WINDOW_HOOKS.target} ${argument}`, timeout: 10 }]
  return matcher == null ? { hooks } : { matcher, hooks }
}

const STOP_ENTRY = windowEntry('stop')
const PRE_COMPACT_ENTRY = windowEntry('pre-compact')
const COMPACT_START_ENTRY = windowEntry('session-start', 'compact')

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-window-hooks-'))
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

function writeSettings(dir: string, content: string): void {
  mkdirSync(path.join(dir, '.claude'), { recursive: true })
  writeFileSync(path.join(dir, SETTINGS_FILE), content)
}

function readSettings(dir: string): unknown {
  return JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))
}

describe('attach puts the tab-window hooks into the working repository', () => {
  it('attach into a clean repository writes the Stop, PreCompact and SessionStart compact hooks', async () => {
    const dir = fixture()

    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')

    expect(readSettings(dir)).toEqual({ hooks: { PreToolUse: [GUARD_ENTRY], Stop: [STOP_ENTRY], PreCompact: [PRE_COMPACT_ENTRY], SessionStart: [COMPACT_START_ENTRY] }, permissions: { allow: engramRules(dir, home()) } })
    expect(readFileSync(path.join(dir, ATTACH_WINDOW_HOOKS.target)).equals(readFileSync(TEMPLATE))).toBe(true)
    const record = readAttachRecord(dir)
    expect(Object.keys(record?.files ?? {})).toContain(ATTACH_WINDOW_HOOKS.target)
    expect(record?.settingsHook?.window).toEqual(WINDOW_EVENTS.map(event => ({ event, entry: WINDOW_ENTRIES[event], created: true })))
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('attach into a repository with its own settings keeps its hooks and adds the window hooks', async () => {
    const dir = fixture()
    const own = { hooks: [{ type: 'command', command: 'true' }] }
    const existing = { permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [own], SessionStart: [{ matcher: 'startup', ...own }] } }
    writeSettings(dir, JSON.stringify(existing))

    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')

    expect(readSettings(dir)).toEqual({
      permissions: { allow: [...existing.permissions.allow, ...engramRules(dir, home())] },
      hooks: { Stop: [own, STOP_ENTRY], SessionStart: [{ matcher: 'startup', ...own }, COMPACT_START_ENTRY], PreToolUse: [GUARD_ENTRY], PreCompact: [PRE_COMPACT_ENTRY] },
    })
    expect(readAttachRecord(dir)?.settingsHook?.window?.map(({ event, created }) => [event, created])).toEqual([['Stop', false], ['PreCompact', true], ['SessionStart', false]])
  })

  it('attach refuses a repository whose settings already name the window hooks, with nothing left behind', async () => {
    const dir = fixture()
    const before = JSON.stringify({ hooks: { Stop: [STOP_ENTRY] } })
    writeSettings(dir, before)

    const result = await runAttach(ui, { dir, harness: HARNESS, yes: true })

    expect(result.status).toBe('refused')
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(before)
    expect(existsSync(path.join(dir, ATTACH_WINDOW_HOOKS.target))).toBe(false)
  })
})

describe('detach takes the window hooks out', () => {
  it('detach removes the window hooks and restores the original settings byte for byte', async () => {
    const dir = fixture()
    const before = `${JSON.stringify({ permissions: { allow: [] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }, null, 4)}\n`
    writeSettings(dir, before)
    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')
    expect(readSettings(dir)).toMatchObject({ hooks: { PreCompact: [PRE_COMPACT_ENTRY], SessionStart: [COMPACT_START_ENTRY] } })
    expect(existsSync(path.join(dir, ATTACH_WINDOW_HOOKS.target))).toBe(true)

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(before)
    expect(existsSync(path.join(dir, ATTACH_WINDOW_HOOKS.target))).toBe(false)
  })

  it('detach cuts the window hooks out of settings edited since attach and keeps the edit', async () => {
    const dir = fixture()
    const own = { hooks: [{ type: 'command', command: 'true' }] }
    writeSettings(dir, JSON.stringify({ hooks: { Stop: [own] } }))
    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')
    const settings = readSettings(dir) as { hooks: Record<string, unknown>, env?: unknown }
    writeSettings(dir, JSON.stringify({ ...settings, env: { A: '1' } }))

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(readSettings(dir)).toEqual({ hooks: { Stop: [own] }, env: { A: '1' } })
  })

  it('detach deletes the settings file it created for the guard and the window hooks', async () => {
    const dir = fixture()
    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('detach refuses settings whose window hook was edited since attach, and removes nothing', async () => {
    const dir = fixture()
    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')
    const settings = readSettings(dir) as { hooks: Record<string, unknown> }
    writeSettings(dir, JSON.stringify({ hooks: { ...settings.hooks, Stop: [windowEntry('stop --loud')] } }))

    expect(runDetach(ui, { dir })).toMatchObject({ status: 'refused', refusal: 'changed' })
    expect(existsSync(path.join(dir, ATTACH_WINDOW_HOOKS.target))).toBe(true)
  })
})

function handoff(text: string): string {
  const file = path.join(home(), 'miko.md')
  writeFileSync(file, text)
  return file
}

function hook(event: string, input: unknown, env: NodeJS.ProcessEnv = {}): { stdout: string, stderr: string, status: number | null } {
  const { CONSTRUCT_CARD: _card, CONSTRUCT_BUS_RAISED: _raised, CLAUDE_CODE_ENTRYPOINT: _entrypoint, CONSTRUCT_HANDOFF: _handoff, ...rest } = process.env
  const run = spawnSync(process.execPath, [TEMPLATE, event], { input: JSON.stringify(input), encoding: 'utf8', env: { ...rest, HOME: home(), CONSTRUCT_HANDOFF_DIR: home(), ...env } })
  return { stdout: run.stdout, stderr: run.stderr, status: run.status }
}

describe('the window hooks script ships self-contained', () => {
  it('stop blocks the stop of a tab window whose handoff ends STATUS: CONTINUE', () => {
    handoff('STATUS: OWNER\nSTATUS: CONTINUE\n')
    const run = hook('stop', { session_id: 's1' })
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({ decision: 'block' })
  })

  for (const status of ['OWNER', 'DONE']) {
    it(`stop lets the turn end when the handoff ends STATUS: ${status}`, () => {
      handoff(`STATUS: CONTINUE\nSTATUS: ${status}\n`)
      expect(hook('stop', { session_id: 's1' }).stdout).toBe('')
    })
  }

  it('stop lets the second stop in a row through', () => {
    handoff('STATUS: CONTINUE\n')
    expect(hook('stop', { session_id: 's1', stop_hook_active: true }).stdout).toBe('')
  })

  for (const [name, env] of [['a card session', { CONSTRUCT_CARD: '1267' }], ['a headless session', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }], ['a bus-raised session', { CONSTRUCT_BUS_RAISED: '1' }]] as const) {
    it(`stop leaves ${name} alone`, () => {
      handoff('STATUS: CONTINUE\n')
      expect(hook('stop', { session_id: 's1' }, env).stdout).toBe('')
    })
  }

  it('session-start after a compaction tells the window to continue from its handoff', () => {
    const file = handoff('STATUS: CONTINUE\n')
    const output = JSON.parse(hook('session-start', { source: 'compact' }).stdout) as { hookSpecificOutput: { hookEventName: string, additionalContext: string } }
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(output.hookSpecificOutput.additionalContext).toContain(file)
  })

  it('session-start adds nothing on a fresh start or without a handoff', () => {
    handoff('STATUS: CONTINUE\n')
    expect(hook('session-start', { source: 'startup' }).stdout).toBe('')
    expect(hook('session-start', { source: 'compact' }, { CONSTRUCT_HANDOFF: path.join(home(), 'absent.md') }).stdout).toBe('')
  })

  it('pre-compact names a stale handoff in a systemMessage the owner sees and stays quiet for a fresh one', () => {
    const file = handoff('STATUS: CONTINUE\n')
    expect(hook('pre-compact', { trigger: 'auto' }).stdout).toBe('')
    utimesSync(file, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000))
    const run = hook('pre-compact', { trigger: 'auto' })
    expect(run.status).toBe(0)
    expect((JSON.parse(run.stdout) as { systemMessage: string }).systemMessage).toContain(file)
  })

  it('pre-compact names a missing handoff in a systemMessage', () => {
    const absent = path.join(home(), 'absent.md')
    const run = hook('pre-compact', { trigger: 'manual' }, { CONSTRUCT_HANDOFF: absent })
    expect((JSON.parse(run.stdout) as { systemMessage: string }).systemMessage).toContain(absent)
  })
})

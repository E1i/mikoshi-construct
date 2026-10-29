import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { openBus } from '../scripts/core/db.js'
import { WINDOW_HEARTBEAT } from '../scripts/core/events.js'
import { runInit } from '../src/commands/init.js'
import { factoryLiveness } from '../src/commands/liveness.js'
import { mergeHookSettings } from '../src/materialize/strategies.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SETTINGS = '.claude/settings.json'
const EDDIES_CONFIG = '.claude/eddies.json'
const EDDIES_HOOK = 'scripts/construct/eddies.mjs'
const EDDIES_MEASURE = 'scripts/construct/eddies-measure.mjs'
const WINDOW_HEARTBEAT_HOOK = 'scripts/construct/window-heartbeat.mjs'
const BROWSER_LAB_EXCLUSION = 'node scripts/construct/browser-lab.mjs *'

interface Settings {
  permissions?: { allow?: string[], ask?: string[] }
  sandbox?: { excludedCommands?: string[] }
  hooks: Record<string, { matcher?: string, hooks: { command: string }[] }[]>
}

const ui = createUi(resolveTheme({ plain: true }), silentWriter)

function scratch(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

async function freshInit(): Promise<{ dir: string, written: string[] }> {
  const dir = scratch('construct-parity-settings-')
  mkdirSync(path.join(dir, '.git'))
  const result = await runInit(ui, { dir, preset: 'node-backend', ai: 'claude', yes: true, dryRun: false, env: {}, home: scratch('construct-parity-home-') })
  return { dir, written: result.written }
}

function settingsOf(dir: string): Settings {
  return JSON.parse(readFileSync(path.join(dir, SETTINGS), 'utf8')) as Settings
}

function commandsOf(settings: Settings, event: string): string[] {
  return (settings.hooks[event] ?? []).flatMap(entry => entry.hooks.map(hook => hook.command))
}

function hookCommand(script: string, argument?: string): string {
  return `node "$CLAUDE_PROJECT_DIR"/${script}${argument == null ? '' : ` ${argument}`}`
}

function windowEnv(home: string, bus: string): NodeJS.ProcessEnv {
  const { CONSTRUCT_CARD: _card, CONSTRUCT_BUS_RAISED: _raised, CLAUDE_CODE_ENTRYPOINT: _entrypoint, ...rest } = process.env
  return { ...rest, HOME: home, CONSTRUCT_BUS_DB: bus }
}

function transcriptIn(dir: string): string {
  const file = path.join(dir, 'session.jsonl')
  const usage = { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 1000 }
  writeFileSync(file, `${JSON.stringify({ requestId: 'r1', message: { role: 'assistant', usage } })}\n`)
  return file
}

describe('init carries the settings layer the factory runs on', () => {
  it('a fresh init carries eddies.json, the eddies hooks and the window heartbeat', async () => {
    const { dir, written } = await freshInit()
    expect(written).toEqual(expect.arrayContaining([EDDIES_CONFIG, EDDIES_HOOK, EDDIES_MEASURE, WINDOW_HEARTBEAT_HOOK]))
    expect(readFileSync(path.join(dir, EDDIES_CONFIG), 'utf8')).toBe(readFileSync(path.join(REPO_ROOT, EDDIES_CONFIG), 'utf8'))
    const settings = settingsOf(dir)
    expect(commandsOf(settings, 'PreToolUse')).toContain(hookCommand(EDDIES_HOOK, 'guard'))
    expect(commandsOf(settings, 'UserPromptSubmit')).toContain(hookCommand(EDDIES_HOOK, 'prompt'))
    expect(commandsOf(settings, 'PostToolUse')).toContain(hookCommand(WINDOW_HEARTBEAT_HOOK))

    const home = scratch('construct-parity-beat-')
    const bus = path.join(home, 'bus.db')
    openBus(bus).close()
    const now = Date.now()
    const run = spawnSync(process.execPath, [path.join(dir, WINDOW_HEARTBEAT_HOOK)], {
      input: JSON.stringify({ session_id: 'tab-1', transcript_path: transcriptIn(home) }),
      encoding: 'utf8',
      env: { ...windowEnv(home, bus), CLAUDE_PROJECT_DIR: dir },
    })
    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')
    const db = openBus(bus)
    const rows = db.prepare('SELECT actor, payload FROM events WHERE type = ?').all(WINDOW_HEARTBEAT) as { actor: string, payload: string }[]
    db.close()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe('worker:window:tab-1')
    expect(JSON.parse(rows[0]!.payload)).toEqual({ session: 'tab-1', mode: 'tab', root: dir, context: 1120, spent: 225 })
    expect(factoryLiveness(bus, now).state).toBe('live')
  })

  it('a fresh init lets the window edit and write its own repo', async () => {
    const { dir } = await freshInit()
    const permissions = settingsOf(dir).permissions
    expect(permissions?.allow).toEqual(expect.arrayContaining(['Edit(/**)', 'Write(/**)']))
    expect(permissions?.ask).toEqual(expect.arrayContaining(['Edit(/.claude/settings*.json)', 'Write(/.claude/settings*.json)', 'Edit(/.claude/eddies.json)', 'Write(/.claude/eddies.json)']))
  })

  it('merging hooks into an existing settings.json keeps its sandbox key', () => {
    const template = readFileSync(path.join(REPO_ROOT, 'templates/ai/claude/_claude/settings.json'), 'utf8')
    const without = JSON.parse(mergeHookSettings(JSON.stringify({ model: 'x' }), template)!) as Settings
    expect(without.sandbox).toEqual({ excludedCommands: [BROWSER_LAB_EXCLUSION] })
    const own = { sandbox: { enabled: true, excludedCommands: ['docker *'] } }
    const withOwn = JSON.parse(mergeHookSettings(JSON.stringify(own), template)!) as Settings
    expect(withOwn.sandbox).toEqual({ enabled: true, excludedCommands: ['docker *', BROWSER_LAB_EXCLUSION] })
    const merged = mergeHookSettings(JSON.stringify(withOwn), template)!
    expect(JSON.parse(merged)).toEqual(withOwn)
    expect(mergeHookSettings(JSON.stringify({ sandbox: { excludedCommands: 'docker *' } }), template)).toBeNull()
  })
})

describe('the budget layer ships as the factory runs it', () => {
  it('keeps the measuring hook byte-identical to this repository\'s own', () => {
    expect(readFileSync(path.join(REPO_ROOT, 'templates/ai/claude', EDDIES_MEASURE)).equals(readFileSync(path.join(REPO_ROOT, '.claude/hooks/eddies-measure.mjs')))).toBe(true)
  })

  it('keeps eddies.json identical to this repository\'s own limits', () => {
    expect(readFileSync(path.join(REPO_ROOT, 'templates/ai/claude/_claude/eddies.json'), 'utf8')).toBe(readFileSync(path.join(REPO_ROOT, EDDIES_CONFIG), 'utf8'))
  })

  it('names no factory-only command in the eddies hook a generated repository runs', () => {
    const hook = readFileSync(path.join(REPO_ROOT, 'templates/ai/claude', EDDIES_HOOK), 'utf8')
    for (const word of ['pnpm miko', 'handoff:write', 'scripts/window/'])
      expect(hook, word).not.toContain(word)
  })
})

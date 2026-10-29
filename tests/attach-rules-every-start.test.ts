import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { runAttach, SETTINGS_FILE } from '../src/commands/attach/index.js'
import { engramRules, WINDOW_ENTRIES } from '../src/commands/attach/settings.js'
import { askDetach } from '../src/commands/detach/index.js'
import { ATTACH_WINDOW_HOOKS } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const TEMPLATE = path.join(import.meta.dirname, '../templates/attach/_construct/window-hooks.mjs')
const RULES = 'the rules of the window\n'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const home = useIsolatedHome()

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-rules-every-start-'))
  mkdirSync(path.join(dir, '.construct'))
  writeFileSync(path.join(dir, ATTACH_WINDOW_HOOKS.rules), RULES)
  return dir
}

function sessionStart(dir: string, source: string, handoff?: string): string {
  const { CONSTRUCT_CARD: _card, CONSTRUCT_BUS_RAISED: _raised, CLAUDE_CODE_ENTRYPOINT: _entrypoint, CONSTRUCT_HANDOFF: _handoff, CONSTRUCT_BUS_DB: _bus, ...rest } = process.env
  const file = path.join(home(), 'rules-every-start-handoff.md')
  if (handoff != null)
    writeFileSync(file, handoff)
  const run = spawnSync(process.execPath, [TEMPLATE, 'session-start'], {
    input: JSON.stringify({ source }),
    encoding: 'utf8',
    env: { ...rest, HOME: home(), CLAUDE_PROJECT_DIR: dir, CONSTRUCT_HANDOFF: handoff == null ? path.join(home(), 'absent.md') : file },
  })
  if (run.stdout === '')
    return ''
  return (JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
}

describe('the attached window gets its rules at every session start', () => {
  it('a fresh start serves the text of window-rules.md', () => {
    expect(sessionStart(project(), 'startup', 'STATUS: CONTINUE\n')).toBe(RULES)
  })

  it('a start without a rules file adds nothing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-rules-every-start-'))
    expect(sessionStart(dir, 'startup')).toBe('')
  })

  it('a compaction serves the rules and then the handoff line', () => {
    const context = sessionStart(project(), 'compact', 'STATUS: CONTINUE\n')
    expect(context.startsWith(RULES)).toBe(true)
    expect(context).toContain('rules-every-start-handoff.md')
  })

  it('the SessionStart entry has no matcher', () => {
    expect(WINDOW_ENTRIES.SessionStart).not.toHaveProperty('matcher')
  })
})

describe('the engram permissions hold no Write rule', () => {
  it('engramRules names Read and Edit only', () => {
    expect(engramRules(project(), home()).map(rule => rule.split('(')[0])).toEqual(['Read', 'Edit'])
  })

  it('attach writes no Write rule and detach removes the others', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-rules-every-start-'))
    cpSync(EXISTING_MONOREPO, dir, { recursive: true })
    spawnSync('git', ['init', '-q'], { cwd: dir })
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir })
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir })

    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    const settings = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as { permissions: { allow: string[] } }
    expect(settings.permissions.allow.some(rule => rule.startsWith('Write('))).toBe(false)
    expect(settings.permissions.allow).toEqual(engramRules(dir, home()))

    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
  })
})

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { runAttach, SETTINGS_FILE } from '../src/commands/attach/index.js'
import { WINDOW_ENTRIES } from '../src/commands/attach/settings.js'
import { runDetach } from '../src/commands/detach/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const TWINS = [
  path.join(import.meta.dirname, '../templates/ai/claude/scripts/construct/window-hooks.mjs'),
  path.join(import.meta.dirname, '../templates/attach/_construct/window-hooks.mjs'),
]
const REASON = 'write the handoff with miko handoff write <name> <draft>'
const HANDOFF_DIR = '/home/someone/.construct/owner--repo/handoff'

function preToolUse(template: string, filePath: unknown, extra: Record<string, string> = {}, dir = mkdtempSync(path.join(tmpdir(), 'construct-handoff-guard-'))): string {
  const { CONSTRUCT_CARD: _card, CONSTRUCT_BUS_RAISED: _raised, CLAUDE_CODE_ENTRYPOINT: _entrypoint, CONSTRUCT_HANDOFF: _handoff, ...rest } = process.env
  const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } })
  const env = { ...rest, CONSTRUCT_HANDOFF_DIR: HANDOFF_DIR, CLAUDE_PROJECT_DIR: dir, ...extra }
  return spawnSync(process.execPath, [template, 'pre-tool-use'], { cwd: dir, input, encoding: 'utf8', env }).stdout
}

describe.each(TWINS)('the window hook of %s guards the handoff directory', (template) => {
  it('a write into the handoff directory is denied with the command to use', () => {
    expect(JSON.parse(preToolUse(template, `${HANDOFF_DIR}/miko.md`))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON },
    })
  })

  it('a path below the handoff directory is denied', () => {
    expect(preToolUse(template, `${HANDOFF_DIR}/drafts/next.md`)).toContain('"permissionDecision":"deny"')
  })

  it('a write outside the handoff directory is let through', () => {
    expect(preToolUse(template, '/work/repo/src/a.ts')).toBe('')
    expect(preToolUse(template, `${HANDOFF_DIR}-other/miko.md`)).toBe('')
  })

  it('a call without a file path is let through', () => {
    expect(preToolUse(template, undefined)).toBe('')
  })

  it('with CONSTRUCT_HANDOFF set, a write beside that file is let through and the handoff directory stays guarded', () => {
    const override = { CONSTRUCT_HANDOFF: '/repo/miko.md' }
    expect(preToolUse(template, '/repo/src/a.ts', override)).toBe('')
    expect(preToolUse(template, '/repo/miko.md', override)).toBe('')
    expect(preToolUse(template, `${HANDOFF_DIR}/miko.md`, override)).toContain('"permissionDecision":"deny"')
  })

  it('a relative path resolves against the project directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-handoff-guard-'))
    const guarded = mkdtempSync(path.join(tmpdir(), 'construct-handoff-dir-'))
    const relative = path.relative(dir, path.join(guarded, 'miko.md'))
    expect(preToolUse(template, relative, { CONSTRUCT_HANDOFF_DIR: guarded }, dir)).toContain('"permissionDecision":"deny"')
    expect(preToolUse(template, 'src/a.ts', { CONSTRUCT_HANDOFF_DIR: guarded }, dir)).toBe('')
  })

  it('dot-dot segments are resolved before comparing', () => {
    expect(preToolUse(template, `${HANDOFF_DIR}/../../other/a.md`)).toBe('')
    expect(preToolUse(template, '/work/repo/../../home/someone/.construct/owner--repo/handoff/miko.md')).toContain('"permissionDecision":"deny"')
  })

  it('a symlink into the handoff directory and another spelling of the directory are denied', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-handoff-link-')))
    const guarded = path.join(root, 'handoff')
    mkdirSync(guarded)
    const link = path.join(root, 'link')
    symlinkSync(guarded, link)
    const aliasOfDirectory = path.join(root, 'alias')
    symlinkSync(root, aliasOfDirectory)
    const env = { CONSTRUCT_HANDOFF_DIR: guarded }
    expect(preToolUse(template, `${link}/miko.md`, env)).toContain('"permissionDecision":"deny"')
    expect(preToolUse(template, `${aliasOfDirectory}/handoff/new/miko.md`, env)).toContain('"permissionDecision":"deny"')
    expect(preToolUse(template, `${aliasOfDirectory}/other/miko.md`, env)).toBe('')
  })

  it('a card session is never guarded', () => {
    expect(preToolUse(template, `${HANDOFF_DIR}/miko.md`, { CONSTRUCT_CARD: '1' })).toBe('')
  })
})

describe('attach registers the guard on the three writing tools', () => {
  it('the PreToolUse window entry carries the matcher', () => {
    expect(WINDOW_ENTRIES.PreToolUse).toMatchObject({ matcher: 'Write|Edit|MultiEdit' })
  })
})

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const home = useIsolatedHome()

function attachedFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-handoff-detach-'))
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return dir
}

function preToolUseList(dir: string): unknown[] {
  const settings = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as { hooks?: { PreToolUse?: unknown[] } }
  return settings.hooks?.PreToolUse ?? []
}

describe('detach removes the guard entry from the list the window entry shares', () => {
  it('attach puts the guard and the window entry in one PreToolUse list and detach empties the settings', async () => {
    const dir = attachedFixture()
    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    expect(preToolUseList(dir)).toHaveLength(2)
    expect(preToolUseList(dir)).toContainEqual(WINDOW_ENTRIES.PreToolUse)
    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(() => readFileSync(path.join(dir, SETTINGS_FILE))).toThrow()
    expect(home()).toBeTruthy()
  })

  it('a user entry in that list stays', async () => {
    const dir = attachedFixture()
    const user = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] }
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ hooks: { PreToolUse: [user] } }))
    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    expect(preToolUseList(dir)).toHaveLength(3)
    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(preToolUseList(dir)).toEqual([user])
  })
})

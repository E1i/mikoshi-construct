import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAttachRecord, runAttach } from '../src/commands/attach/index.js'
import { runDetach } from '../src/commands/detach/index.js'
import { ATTACH_WINDOW_HOOKS } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const RULES_TEMPLATE = path.join(import.meta.dirname, '../templates/attach/_construct/window-rules.md')

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
useIsolatedHome()

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-window-carriers-'))
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

describe('attach carries the window hooks and rules with push none', () => {
  it('attach with defaults records push none and writes the hooks and the rules as excluded files', async () => {
    const dir = fixture()

    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')

    const record = readAttachRecord(dir)
    expect(record?.push).toBe('none')
    expect(Object.keys(record?.files ?? {})).toEqual(expect.arrayContaining([ATTACH_WINDOW_HOOKS.target, ATTACH_WINDOW_HOOKS.rules]))
    expect(readFileSync(path.join(dir, ATTACH_WINDOW_HOOKS.rules)).equals(readFileSync(RULES_TEMPLATE))).toBe(true)
    expect(git(dir, 'check-ignore', ATTACH_WINDOW_HOOKS.rules, ATTACH_WINDOW_HOOKS.target).split('\n').filter(Boolean)).toHaveLength(2)
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('the rules carry nothing specific to mikoshi-construct', () => {
    const rules = readFileSync(RULES_TEMPLATE, 'utf8')
    for (const word of ['Kukloda', 'Ghost', 'owner-decisions', 'bus heartbeat', 'card #'])
      expect(rules).not.toContain(word)
  })

  it('detach removes the hooks and the rules and leaves git status empty', async () => {
    const dir = fixture()
    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(existsSync(path.join(dir, ATTACH_WINDOW_HOOKS.rules))).toBe(false)
    expect(existsSync(path.join(dir, ATTACH_WINDOW_HOOKS.target))).toBe(false)
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })
})

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAttach } from '../src/commands/attach/index.js'
import { MODEL_FILE } from '../src/model/schema.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
useIsolatedHome()

const FOREIGN: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'shop', private: true, scripts: { quality: 'node --version' } }, null, 2)}\n`,
  'src/orders/api.ts': 'export function place(): void {}\n',
  'README.md': '# shop\n',
  'CLAUDE.md': '# shop\n\nOur own agent notes.\n',
  'AGENTS.md': '# shop agents\n',
  '.gitignore': 'node_modules\n',
  [MODEL_FILE]: `${JSON.stringify({ modelVersion: 1, facts: [], claims: [], hypotheses: [], ours: true }, null, 2)}\n`,
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

function foreignRepository(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-tracked-'))
  for (const [file, content] of Object.entries(FOREIGN)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

function trackedBytes(dir: string): Record<string, string> {
  const tracked = git(dir, 'ls-files', '-z').split('\0').filter(file => file !== '')
  return Object.fromEntries(tracked.map(file => [file, readFileSync(path.join(dir, file), 'utf8')]))
}

describe('construct attach on a foreign repository', () => {
  it('attach on a foreign repository leaves every tracked file unchanged, construct.model.json included', async () => {
    const dir = foreignRepository()
    const before = trackedBytes(dir)
    expect(Object.keys(before)).toContain(MODEL_FILE)
    expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
    expect(trackedBytes(dir)).toEqual(before)
    expect(git(dir, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(git(dir, 'ls-files', '-z').split('\0').filter(file => file !== '')).toEqual(Object.keys(before))
  })
})

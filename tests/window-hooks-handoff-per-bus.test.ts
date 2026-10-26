import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { repoIdOf as busRepoIdOf } from '../scripts/core/bus-path.js'
import { useIsolatedHome } from './isolated-home.js'

const TWINS = [
  path.join(import.meta.dirname, '../templates/ai/claude/scripts/construct/window-hooks.mjs'),
  path.join(import.meta.dirname, '../templates/attach/_construct/window-hooks.mjs'),
]
const MIKOSHI_HANDOFF = ['.construct', 'handoff', 'miko.md']

const home = useIsolatedHome()

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

function repository(remote: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-repo-b-'))
  git(dir, 'init', '-q')
  if (remote !== null)
    git(dir, 'remote', 'add', 'origin', remote)
  return dir
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function stop(template: string, dir: string): string {
  const { CONSTRUCT_CARD: _card, CONSTRUCT_BUS_RAISED: _raised, CLAUDE_CODE_ENTRYPOINT: _entrypoint, CONSTRUCT_HANDOFF: _handoff, CONSTRUCT_HANDOFF_DIR: _handoffDir, CLAUDE_PROJECT_DIR: _project, ...rest } = process.env
  return spawnSync(process.execPath, [template, 'stop'], { cwd: dir, input: JSON.stringify({ session_id: 's1' }), encoding: 'utf8', env: { ...rest, HOME: home(), CLAUDE_PROJECT_DIR: dir } }).stdout
}

describe.each(TWINS)('the window hooks of %s read the handoff of their own repository', (template) => {
  it('a stop in repository B is not held by the mikoshi-construct handoff ending STATUS: CONTINUE', () => {
    write(path.join(home(), ...MIKOSHI_HANDOFF), 'STATUS: CONTINUE\n')
    expect(stop(template, repository('git@github.com:E1i/repo-b.git'))).toBe('')
  })

  it('a stop in repository B is held by repository B\'s own handoff ending STATUS: CONTINUE', () => {
    const dir = repository('git@github.com:E1i/repo-b.git')
    write(path.join(home(), '.construct', 'E1i--repo-b', 'handoff', 'miko.md'), 'STATUS: CONTINUE\n')
    expect(JSON.parse(stop(template, dir))).toMatchObject({ decision: 'block' })
  })

  it('a repository with no handoff of its own never blocks a stop', () => {
    write(path.join(home(), ...MIKOSHI_HANDOFF), 'STATUS: CONTINUE\n')
    expect(stop(template, repository(null))).toBe('')
  })

  for (const remote of ['git@github.com:E1i/repo-b.git', 'https://github.com/E1i/repo b.git', null]) {
    it(`names the repository as its bus does, for remote ${remote ?? 'none'}`, async () => {
      const dir = repository(remote)
      const hooks = await import(template) as { repoIdOf: (dir: string) => string }
      expect(hooks.repoIdOf(dir)).toBe(busRepoIdOf(dir))
    })
  }
})

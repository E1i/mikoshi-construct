import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ownerPullCommand, realMikoPullDeps, runMikoPull } from '../../window/pull.js'

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false']
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...IDENTITY, '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function commitFile(tree: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
  writeFileSync(path.join(tree, file), text)
  git(tree, ['add', '-A'])
  git(tree, ['commit', '-q', '-m', file])
}

function mainTreeBehindOrigin(incoming: string[]): { main: string, ahead: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'miko-pull-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const main = path.join(root, 'main')
  const other = path.join(root, 'other')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' })
  git(other, ['checkout', '-q', '-b', 'main'])
  commitFile(other, 'README.md', 'base\n')
  git(other, ['push', '-q', 'origin', 'main'])
  execFileSync('git', ['clone', '-q', '-b', 'main', origin, main], { stdio: 'ignore' })
  for (const file of incoming)
    commitFile(other, file, `${file}\n`)
  git(other, ['push', '-q', 'origin', 'main'])
  return { main, ahead: git(other, ['rev-parse', 'HEAD']).trim() }
}

function pull(main: string): { code: number, out: string[], err: string[], head: string } {
  const out: string[] = []
  const err: string[] = []
  const deps = realMikoPullDeps(main)
  const code = runMikoPull({ ...deps, out: line => out.push(line), err: line => err.push(line) })
  return { code, out, err, head: git(main, ['rev-parse', 'HEAD']).trim() }
}

describe('pnpm miko:pull', () => {
  it('a pull whose range touches a path the sandbox cannot write is refused before anything is written', () => {
    const { main, ahead } = mainTreeBehindOrigin(['.claude/hooks/window-core.mjs', '.claude/settings.json', 'scripts/miko/new.ts'])
    const before = git(main, ['rev-parse', 'HEAD']).trim()
    const result = pull(main)
    expect(result.code).not.toBe(0)
    expect(result.head).toBe(before)
    expect(result.head).not.toBe(ahead)
    expect(existsSync(path.join(main, 'scripts', 'miko', 'new.ts'))).toBe(false)
    expect(git(main, ['status', '--porcelain'])).toBe('')
    expect(result.err).toHaveLength(1)
    expect(result.err[0]).toContain(ownerPullCommand(main))
    expect(result.err[0]).toContain('.claude/hooks/window-core.mjs')
    expect(result.err[0]).toContain('.claude/settings.json')
    expect(result.err[0]).not.toContain('scripts/miko/new.ts')
    expect(result.out).toEqual([])
  })

  it('an incoming change with no .claude path fast-forwards main', () => {
    const { main, ahead } = mainTreeBehindOrigin(['scripts/miko/new.ts', 'architecture/window.md'])
    const result = pull(main)
    expect(result.code).toBe(0)
    expect(result.head).toBe(ahead)
    expect(existsSync(path.join(main, 'scripts', 'miko', 'new.ts'))).toBe(true)
    expect(result.err).toEqual([])
  })
})

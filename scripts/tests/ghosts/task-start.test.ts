import type { TaskStartDeps } from '../../ghosts/task-start.js'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runTaskStart } from '../../ghosts/task-start.js'

const SESSION = '0d538601-aaaa-bbbb-cccc-1234567890ab'
const NOW = new Date('2026-10-02T08:00:00.000Z')

interface World {
  root: string
  repo: string
  handoff: string
  journal: string
}

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

function newWorld(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-start-world-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'main-tree')
  const handoff = path.join(root, 'handoff')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  writeFileSync(path.join(repo, 'README.md'), 'world\n')
  git(repo, ['checkout', '-q', '-b', 'main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['push', '-q', 'origin', 'main'])
  return { root, repo, handoff, journal: path.join(handoff, 'ghosts.jsonl') }
}

function depsOf(world: World, session: string | null = SESSION): TaskStartDeps {
  return {
    cwd: world.repo,
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    exists: existsSync,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => NOW,
    session: session ?? undefined,
    handoffDir: world.handoff,
  }
}

function lines(world: World): Record<string, unknown>[] {
  return readFileSync(world.journal, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('w1: task:start cuts the tree and writes the start line', () => {
  it('w1: cuts ../mc-<id> on the branch from origin/main and writes one start line with worktree, branch and session', () => {
    const world = newWorld()
    const result = runTaskStart(['t1', 'feat/t1'], depsOf(world))
    const worktree = path.join(world.root, 'mc-t1')
    expect(result.exitCode).toBe(0)
    expect(existsSync(worktree)).toBe(true)
    expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feat/t1')
    expect(lines(world)).toEqual([{ event: 'path', task: 't1', path: 'cheap', started: NOW.toISOString(), session: SESSION, worktree, branch: 'feat/t1', ts: NOW.toISOString() }])
  })

  it('w1: writes a line without session and says the board will show WINDOW UNKNOWN when no session is set', () => {
    const world = newWorld()
    const result = runTaskStart(['t2', 'feat/t2'], depsOf(world, null))
    expect(result.exitCode).toBe(0)
    expect(lines(world)[0]).not.toHaveProperty('session')
    expect(result.stdout.join('\n')).toContain('WINDOW UNKNOWN (no session)')
  })

  it('w1: refuses an existing tree path and writes nothing', () => {
    const world = newWorld()
    mkdirSync(path.join(world.root, 'mc-t3'))
    const result = runTaskStart(['t3', 'feat/t3'], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toMatch(/^\[task:start\] .*mc-t3 already exists/)
    expect(existsSync(world.journal)).toBe(false)
    expect(git(world.repo, ['branch', '--list', 'feat/t3']).trim()).toBe('')
  })

  it('w1: refuses an existing local branch and writes nothing', () => {
    const world = newWorld()
    git(world.repo, ['branch', 'feat/t4'])
    const result = runTaskStart(['t4', 'feat/t4'], depsOf(world))
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toMatch(/^\[task:start\] branch feat\/t4 already exists/)
    expect(existsSync(path.join(world.root, 'mc-t4'))).toBe(false)
    expect(existsSync(world.journal)).toBe(false)
  })

  it('w1: refuses a task id that would leave the parent directory', () => {
    const world = newWorld()
    expect(runTaskStart(['../x', 'feat/x'], depsOf(world)).exitCode).toBe(1)
    expect(runTaskStart(['x'], depsOf(world)).stderr[0]).toMatch(/^\[task:start\] usage:/)
  })
})

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commitAndPush } from '../../nodes/launch/tree-pr.js'
import { gitOutcomeOf, GitRaceLost, syncThroughPort, throughGitPort } from '../../ports/git.js'

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']
const RACE = 'fatal: cannot lock ref \'HEAD\': is at 1111111 but expected 2222222\n'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...IDENTITY, '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function shiftTree(): { origin: string, tree: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'git-ref-lock-race-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const tree = path.join(root, 'tree')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, tree], { stdio: 'ignore' })
  git(tree, ['checkout', '-q', '-b', 'main'])
  writeFileSync(path.join(tree, 'base.txt'), 'base\n')
  git(tree, ['add', '-A'])
  git(tree, ['commit', '-q', '-m', 'base'])
  git(tree, ['push', '-q', 'origin', 'main'])
  git(tree, ['checkout', '-q', '-b', 'feat/race'])
  writeFileSync(path.join(tree, 'work.txt'), 'the shift work\n')
  return { origin, tree }
}

const quick = { attempts: 3, firstMs: 1, sleep: () => {} }

describe('the ref-lock race in the one git port', () => {
  it('a ref lock on HEAD during the shift fetch is retried and the commit exists', () => {
    const { origin, tree } = shiftTree()
    const fetches: string[][] = []
    const racing = (cwd: string, args: string[]): string => {
      if (args[0] === 'fetch') {
        fetches.push(args)
        if (fetches.length === 1)
          throw Object.assign(new Error('Command failed: git fetch -q origin main'), { stderr: RACE })
      }
      return git(cwd, args)
    }

    expect(commitAndPush(racing, tree, 'feat/race', 'the shift commit')).toEqual({ kind: 'pushed' })
    expect(fetches).toHaveLength(2)
    expect(git(origin, ['log', '-1', '--format=%s', 'feat/race']).trim()).toBe('the shift commit')
    expect(git(origin, ['show', 'feat/race:work.txt'])).toBe('the shift work\n')
  })

  it('a race that keeps losing past the bound is named apart from a refusal', () => {
    let calls = 0
    const alwaysRacing = (): string => {
      calls += 1
      throw Object.assign(new Error('Command failed: git push'), { stderr: RACE })
    }

    expect(() => syncThroughPort(alwaysRacing, '/tree', ['push', 'origin'], quick)).toThrow(GitRaceLost)
    expect(calls).toBe(3)
  })

  it('a real refusal is not retried and keeps its text', () => {
    let calls = 0
    const refused = Object.assign(new Error('Command failed: git commit'), { stderr: 'fatal: Unable to create \'/repo/.git/worktrees/mc-1/index.lock\': Operation not permitted\n' })
    const refusing = (): string => {
      calls += 1
      throw refused
    }

    expect(() => syncThroughPort(refusing, '/tree', ['commit', '-m', 'x'], quick)).toThrow(refused)
    expect(calls).toBe(1)
    expect(gitOutcomeOf(refused)).toEqual({ kind: 'refused', refusal: 'fatal: Unable to create \'/repo/.git/worktrees/mc-1/index.lock\': Operation not permitted' })
  })

  it('a read is never retried by the port', () => {
    let calls = 0
    const reading = (): string => {
      calls += 1
      throw Object.assign(new Error('Command failed: git rev-parse'), { stderr: RACE })
    }

    expect(() => throughGitPort(reading, quick)('/tree', ['rev-parse', 'HEAD'])).toThrow('Command failed: git rev-parse')
    expect(calls).toBe(1)
  })
  it('a command already bound to the port and wrapped again keeps the one bound of attempts', () => {
    let calls = 0
    const alwaysRacing = (): string => {
      calls += 1
      throw Object.assign(new Error('Command failed: git push'), { stderr: RACE })
    }
    const bound = throughGitPort(alwaysRacing, quick)

    expect(() => throughGitPort(bound, quick)('/tree', ['push', 'origin'])).toThrow(GitRaceLost)
    expect(calls).toBe(quick.attempts)
    calls = 0
    expect(() => syncThroughPort(bound, '/tree', ['fetch', 'origin'], quick)).toThrow(GitRaceLost)
    expect(calls).toBe(quick.attempts)
  })
})

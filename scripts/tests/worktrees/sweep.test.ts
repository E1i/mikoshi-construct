import type { SweepDeps } from '../../worktrees/sweep.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runSweep } from '../../worktrees/sweep.js'

interface World {
  root: string
  repo: string
  journal: string[]
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

function newWorld(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sweep-world-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'main-tree')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  writeFileSync(path.join(repo, 'README.md'), 'world\n')
  git(repo, ['checkout', '-q', '-b', 'main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['push', '-q', 'origin', 'main'])
  return { root, repo, journal: [] }
}

function cut(world: World, id: number): string {
  const tree = path.join(world.root, 'trees', `mc-${id}`)
  git(world.repo, ['worktree', 'add', '-q', '-b', `feat/${id}`, tree, 'origin/main'])
  world.journal.push(JSON.stringify({ event: 'path', task: String(id), path: 'cheap', worktree: tree, branch: `feat/${id}` }))
  return tree
}

function closed(world: World, id: number, pr: number): void {
  world.journal.push(JSON.stringify({ event: 'path', task: String(id), path: 'cheap', pr, verification: 'run' }))
}

function merged(world: World, id: number, pr: number): void {
  closed(world, id, pr)
  world.journal.push(JSON.stringify({ event: 'merge', task: String(id), pr, by: 'E1i', commit: 'c0ffee' }))
}

function commit(tree: string, file: string): string {
  writeFileSync(path.join(tree, file), `${file}\n`)
  git(tree, ['add', '.'])
  git(tree, ['commit', '-q', '-m', file])
  return git(tree, ['rev-parse', 'HEAD']).trim()
}

function branchExists(world: World, branch: string): boolean {
  return git(world.repo, ['branch', '--list', branch]).trim() !== ''
}

function depsOf(world: World, heads: Record<number, string> = {}): SweepDeps & { ghCalls: string[][] } {
  const ghCalls: string[][] = []
  return {
    cwd: world.repo,
    handoffDir: path.join(world.root, 'handoff'),
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    gh: (args) => {
      ghCalls.push(args)
      return JSON.stringify({ headRefOid: heads[Number(args[2])] ?? 'not-this-head' })
    },
    readJournal: () => world.journal.map(line => `${line}\n`).join(''),
    ghCalls,
  }
}

describe('worktrees:sweep removes a finished card\'s tree only when nothing in it would be lost', () => {
  it('removes the tree and branch of a merged card with a clean tree', () => {
    const world = newWorld()
    const tree = cut(world, 1)
    merged(world, 1, 101)
    const dry = runSweep([], depsOf(world))
    expect(dry.exitCode).toBe(0)
    expect(dry.stdout[0]).toBe(`[worktrees:sweep] would remove ${tree} and branch feat/1: card #1 is merged, the tree clean, every commit pushed`)
    expect(existsSync(tree)).toBe(true)
    const applied = runSweep(['--apply'], depsOf(world))
    expect(applied.exitCode).toBe(0)
    expect(applied.stdout[0]).toBe(`[worktrees:sweep] removed ${tree} and branch feat/1: card #1 is merged`)
    expect(existsSync(tree)).toBe(false)
    expect(branchExists(world, 'feat/1')).toBe(false)
  })

  it('keeps a dirty tree and a tree with an unpushed commit and lists them', () => {
    const world = newWorld()
    const dirty = cut(world, 2)
    const ahead = cut(world, 3)
    merged(world, 2, 102)
    merged(world, 3, 103)
    writeFileSync(path.join(dirty, 'scratch.txt'), 'work\n')
    commit(ahead, 'local.txt')
    const result = runSweep(['--apply'], depsOf(world))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toEqual([
      `[worktrees:sweep] kept ${dirty}: card #2 is merged, but 1 changed path in the tree`,
      `[worktrees:sweep] kept ${ahead}: card #3 is merged, but 1 commit reachable from no remote ref`,
      '[worktrees:sweep] removed 0, kept 2',
    ])
    expect([existsSync(dirty), existsSync(ahead), branchExists(world, 'feat/2'), branchExists(world, 'feat/3')]).toEqual([true, true, true, true])
  })

  it('keeps a closed card whose pull request is still open', () => {
    const world = newWorld()
    const tree = cut(world, 4)
    closed(world, 4, 104)
    const result = runSweep(['--apply'], depsOf(world))
    expect(result.stdout[0]).toBe(`[worktrees:sweep] kept ${tree}: card #4 is closed but PR #104 is still open (no merge line in the journal)`)
    expect(existsSync(tree)).toBe(true)
  })

  it('removes a closed card whose pull request was closed without a merge', () => {
    const world = newWorld()
    const tree = cut(world, 5)
    closed(world, 5, 105)
    world.journal.push(JSON.stringify({ event: 'merge-skip', pr: 105, skip: 'closed' }))
    expect(runSweep(['--apply'], depsOf(world)).stdout[0]).toBe(`[worktrees:sweep] removed ${tree} and branch feat/5: card #5 is closed and PR #105 was closed without a merge`)
    expect(existsSync(tree)).toBe(false)
  })

  it('does not count a squash-merged branch whose HEAD is the merged pull request\'s head as unpushed', () => {
    const world = newWorld()
    const tree = cut(world, 6)
    const head = commit(tree, 'squashed.txt')
    merged(world, 6, 106)
    const deps = depsOf(world, { 106: head })
    expect(runSweep(['--apply'], deps).stdout[0]).toBe(`[worktrees:sweep] removed ${tree} and branch feat/6: card #6 is merged`)
    expect(deps.ghCalls).toEqual([['pr', 'view', '106', '-R', 'E1i/mikoshi-construct', '--json', 'headRefOid']])
    expect(branchExists(world, 'feat/6')).toBe(false)
  })

  it('keeps an open card and a tree no start line names, each with its reason', () => {
    const world = newWorld()
    const open = cut(world, 7)
    const stray = path.join(world.root, 'stray')
    git(world.repo, ['worktree', 'add', '-q', '-b', 'stray', stray, 'origin/main'])
    expect(runSweep([], depsOf(world)).stdout).toEqual([
      `[worktrees:sweep] kept ${stray}: named by no task:start line in the journal`,
      `[worktrees:sweep] kept ${open}: card #7 is open`,
      '[worktrees:sweep] would remove 0, kept 2',
    ])
  })

  it('with --card sweeps that card\'s tree alone', () => {
    const world = newWorld()
    const one = cut(world, 8)
    const other = cut(world, 9)
    merged(world, 8, 108)
    merged(world, 9, 109)
    expect(runSweep(['--apply', '--card', '9'], depsOf(world)).stdout).toEqual([
      `[worktrees:sweep] removed ${other} and branch feat/9: card #9 is merged`,
      '[worktrees:sweep] removed 1, kept 0',
    ])
    expect([existsSync(one), existsSync(other)]).toEqual([true, false])
    expect(runSweep(['--card', '10'], depsOf(world)).stdout[0]).toBe('[worktrees:sweep] card #10 has no worktree to sweep')
  })

  it('refuses an unknown argument with its usage', () => {
    const world = newWorld()
    expect(runSweep(['--force'], depsOf(world))).toEqual({ stdout: [], stderr: ['[worktrees:sweep] usage: pnpm worktrees:sweep [--apply] [--card <id>]'], exitCode: 1 })
  })
})

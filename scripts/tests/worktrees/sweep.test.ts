import type { SweepDeps } from '../../worktrees/sweep.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { CARD_STARTED } from '../../bus/inbox.js'
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

function startedInTheBus(world: World, id: number): { tree: string, bus: string } {
  const tree = path.join(world.root, 'trees', `mc-${id}`)
  git(world.repo, ['worktree', 'add', '-q', '-b', `feat/${id}`, tree, 'origin/main'])
  const bus = path.join(world.root, 'bus.db')
  const db = openBus(bus)
  try {
    appendEvent(db, { ts: '2026-10-12T12:00:00.000Z', type: CARD_STARTED, actor: 'worker:start:session-1', cardId: id, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${id}:feat/${id}`, payload: { worktree: tree, branch: `feat/${id}` }, legacy: false })
  }
  finally {
    db.close()
  }
  return { tree, bus }
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

  it('finds the tree of a card whose start is recorded only as card.started in the bus', () => {
    const world = newWorld()
    const { tree, bus } = startedInTheBus(world, 4)
    merged(world, 4, 104)
    const applied = runSweep(['--apply'], { ...depsOf(world), bus })
    expect(applied.exitCode).toBe(0)
    expect(applied.stdout[0]).toBe(`[worktrees:sweep] removed ${tree} and branch feat/4: card #4 is merged`)
    expect([existsSync(tree), branchExists(world, 'feat/4')]).toEqual([false, false])
  })

  it('removes the tree of a card the bus holds merged with no merge line in the journal, and keeps one whose merge line came after the journal half of history while the bus runs it', () => {
    const world = newWorld()
    const { tree, bus } = startedInTheBus(world, 5)
    const late = cut(world, 6)
    world.journal.push(JSON.stringify({ event: 'merge', task: '6', pr: 106, by: 'E1i', commit: 'c0ffee', ts: '2026-10-12T18:00:00.000Z' }))
    const db = openBus(bus)
    try {
      db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (5, \'merged\', NULL, 1), (6, \'running\', NULL, 1)').run()
    }
    finally {
      db.close()
    }
    const applied = runSweep(['--apply'], { ...depsOf(world), bus })
    expect(applied.exitCode).toBe(0)
    expect(applied.stdout).toContain(`[worktrees:sweep] removed ${tree} and branch feat/5: card #5 is merged`)
    expect([existsSync(tree), existsSync(late)]).toEqual([false, true])
  })

  it('keeps the tree of a card whose closing path line came after the journal half of history and whose PR was closed without a merge while the bus runs it, as #889', () => {
    const world = newWorld()
    const { bus } = startedInTheBus(world, 7)
    const late = cut(world, 8)
    world.journal.push(JSON.stringify({ event: 'path', task: '8', path: 'ladder', pr: 108, verification: 'run', ts: '2026-10-12T17:07:15.949Z' }))
    world.journal.push(JSON.stringify({ event: 'merge-skip', pr: 108, skip: 'closed' }))
    const db = openBus(bus)
    try {
      db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (8, \'running\', NULL, 1)').run()
    }
    finally {
      db.close()
    }
    const applied = runSweep(['--apply', '--card', '8'], { ...depsOf(world), bus })
    expect(applied.stdout[0]).toBe(`[worktrees:sweep] kept ${late}: card #8 is open`)
    expect(existsSync(late)).toBe(true)
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

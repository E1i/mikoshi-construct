import type { AnswerRun } from '../../nodes/answer/answerer.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { gitCardTrees } from '../../ports/card-tree.js'
import { appendEvent } from '../../core/db.js'
import { importJournal } from '../../intake/import.js'
import { leaseNext } from '../../core/lease.js'
import { CARD_ANSWERED, CARD_STARTED, POLICY_DENIED } from '../../core/events.js'
import { taskWorktree } from '../../ports/worktree-home.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const BRANCH = 'feat/card-1199'
const SESSION = 'card-session-1199'
const IDENTITY = { GIT_AUTHOR_NAME: 'bus', GIT_AUTHOR_EMAIL: 'bus@example.invalid', GIT_COMMITTER_NAME: 'bus', GIT_COMMITTER_EMAIL: 'bus@example.invalid' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...IDENTITY } }).trim()
}

function commit(cwd: string, file: string): void {
  writeFileSync(path.join(cwd, file), `${file}\n`)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', file)
}

function origin(root: string): { repo: string, pushedHead: () => string } {
  const bare = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  const other = path.join(root, 'other')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  execFileSync('git', ['clone', '-q', bare, repo], { stdio: 'ignore' })
  git(repo, 'checkout', '-q', '-b', 'main')
  commit(repo, 'main.txt')
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'branch', BRANCH)
  git(repo, 'push', '-q', 'origin', BRANCH)
  execFileSync('git', ['clone', '-q', '-b', BRANCH, bare, other], { stdio: 'ignore' })
  return {
    repo,
    pushedHead: () => {
      commit(other, 'round-1.txt')
      git(other, 'push', '-q', 'origin', BRANCH)
      return git(other, 'rev-parse', 'HEAD')
    },
  }
}

type Bench = ReturnType<typeof mergeBench>

function startedByLaunch(bench: Bench, tree: string): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 1199, pr: null, head: null, dedupeKey: `${CARD_STARTED}:1199`, payload: { session: SESSION, worktree: tree, branch: BRANCH, base: sha('1') }, legacy: false })
}

function startedByShiftChain(bench: Bench, tree: string): void {
  const ts = bench.clock.now().toISOString()
  importJournal(bench.db, JSON.stringify({ event: 'path', task: '1199', path: 'cheap', started: ts, session: SESSION, shift: '/shift/2026-10-11-a', worktree: tree, branch: BRANCH, ts }))
}

function deletedAfter(start: (bench: Bench, tree: string) => void): (bench: Bench, tree: string, repo: string) => void {
  return (bench, tree, repo) => {
    git(repo, 'worktree', 'add', '-q', tree, BRANCH)
    start(bench, tree)
    rmSync(tree, { recursive: true, force: true })
  }
}

function neverStarted(): void {}

async function roundInRecreatedTree(treeOf: (root: string) => string, start: (bench: Bench, tree: string, repo: string) => void, session: { session: string, resumed: boolean }): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-card-tree-'))
  const bench = mergeBench()
  const { repo, pushedHead } = origin(root)
  const tree = treeOf(root)
  start(bench, tree, repo)
  const head = pushedHead()
  bench.gitHub.open({ number: 1099, review: 'failure', ref: BRANCH })
  bench.tick()

  const installed: string[] = []
  const recreated: string[] = []
  const runs: AnswerRun[] = []
  const answerer = claudeAnswerer(path.join(root, 'answers'), {
    cardText: () => null,
    available: card => card.session === SESSION,
    remoteHead: card => git(card.worktree, 'rev-parse', 'HEAD'),
    spawn: async (run) => {
      runs.push(run)
      commit(run.cwd, 'answer.txt')
      return 0
    },
    newSession: () => 'new-session-1',
    publish: () => {},
  })
  const gitTrees = gitCardTrees(repo, path.join(root, 'worktrees'), (cwd: string) => installed.push(cwd), bench.gitHub.client)
  const trees = {
    ...gitTrees,
    recreate: (worktree: string, branch: string) => {
      recreated.push(worktree)
      gitTrees.recreate(worktree, branch)
    },
  }
  const executor = new AnswerExecutor({ db: bench.db, answerer, ownerMerges: () => '', clock: bench.clock.now, trees })

  const outcome = await executor.answer(leaseNext(bench.db, bench.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!)

  expect(outcome).toMatchObject({ kind: 'answered', ...session })
  expect(recreated).toEqual([tree])
  expect(existsSync(path.join(tree, 'round-1.txt'))).toBe(true)
  expect(git(tree, 'rev-parse', 'HEAD~1')).toBe(head)
  expect(git(tree, 'branch', '--show-current')).toBe(BRANCH)
  expect(installed).toEqual([tree])
  expect(runs.map(run => run.cwd)).toEqual([tree])
  expect(eventsOf(bench.db, CARD_ANSWERED)).toMatchObject([{ ...session, from: head }])
  expect(eventsOf(bench.db, POLICY_DENIED)).toEqual([])
  bench.close()
  rmSync(root, { recursive: true, force: true })
}

const RESUMED = { session: SESSION, resumed: true }

async function roundInAnExistingTree(prepare: (tree: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-card-tree-'))
  const bench = mergeBench()
  const { repo, pushedHead } = origin(root)
  const tree = path.join(root, 'worktrees', 'mc-1199')
  git(repo, 'worktree', 'add', '-q', tree, BRANCH)
  startedByLaunch(bench, tree)
  const behind = git(tree, 'rev-parse', 'HEAD')
  const head = pushedHead()
  prepare(tree)
  bench.gitHub.open({ number: 1099, review: 'failure', ref: BRANCH, head })
  bench.tick()

  const headsAtSpawn: string[] = []
  const answerer = claudeAnswerer(path.join(root, 'answers'), {
    cardText: () => null,
    available: () => true,
    remoteHead: card => git(card.worktree, 'rev-parse', 'HEAD'),
    spawn: async (run) => {
      headsAtSpawn.push(git(run.cwd, 'rev-parse', 'HEAD'))
      commit(run.cwd, 'answer.txt')
      return 0
    },
    newSession: () => 'new-session-1',
    publish: () => {},
  })
  const trees = { ...gitCardTrees(repo, path.join(root, 'worktrees'), () => {}), branchOf: () => BRANCH }
  const executor = new AnswerExecutor({ db: bench.db, answerer, ownerMerges: () => '', clock: bench.clock.now, trees })
  const outcome = await executor.answer(leaseNext(bench.db, bench.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!)
  return {
    behind,
    head,
    outcome,
    headsAtSpawn,
    denials: eventsOf(bench.db, POLICY_DENIED),
    close: () => {
      bench.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('the card tree', () => {
  it('a deleted card tree is recreated from the pull request branch and the round starts', async () => {
    await roundInRecreatedTree(root => path.join(root, 'worktrees', 'mc-1199'), deletedAfter(startedByLaunch), RESUMED)
  })

  it('a deleted card tree recorded outside the worktree home is recreated at its recorded path', async () => {
    await roundInRecreatedTree(root => path.join(root, 'projects', 'mc-1199'), deletedAfter(startedByShiftChain), RESUMED)
  })

  it('the pull request branch comes through the GitHub port, and a pull request it names no branch for is refused', () => {
    const bench = mergeBench()
    bench.gitHub.open({ number: 1098, ref: BRANCH })
    const trees = gitCardTrees('/repo', '/worktrees', () => {}, bench.gitHub.client)
    expect(trees.branchOf(1098)).toBe(BRANCH)
    expect(bench.gitHub.calls).toContain('repos/{owner}/{repo}/pulls/1098')
    bench.gitHub.failing = true
    expect(() => trees.branchOf(1098)).toThrow('gh api: connection refused')
    expect(() => gitCardTrees('/repo', '/worktrees', () => {}, () => ({ status: 200, headers: {}, body: { head: {} } })).branchOf(1097)).toThrow('GitHub names no head branch for pull request #1097')
    bench.close()
  })

  it('a card with no card.started and an open pull request gets its tree from the pull request branch and the round starts', async () => {
    await roundInRecreatedTree(root => taskWorktree(path.join(root, 'worktrees'), '1199'), neverStarted, { session: 'new-session-1', resumed: false })
  })

  it('an existing card tree behind the task head is brought to the head before the answer runs', async () => {
    const round = await roundInAnExistingTree(() => {})
    expect(round.behind).not.toBe(round.head)
    expect(round.headsAtSpawn).toEqual([round.head])
    expect(round.outcome).toMatchObject({ kind: 'answered', resumed: true })
    round.close()
  })

  it('an existing card tree ahead of the task head by its own unpushed commit is kept as it is and the round starts', async () => {
    let local = ''
    const round = await roundInAnExistingTree((tree) => {
      git(tree, 'fetch', '-q', 'origin', BRANCH)
      git(tree, 'merge', '-q', '--ff-only', `origin/${BRANCH}`)
      commit(tree, 'unpushed-answer.txt')
      local = git(tree, 'rev-parse', 'HEAD')
    })
    expect({ headsAtSpawn: round.headsAtSpawn, outcome: round.outcome.kind, denials: round.denials }).toEqual({ headsAtSpawn: [local], outcome: 'answered', denials: [] })
    round.close()
  })

  it.each([
    { gap: 'commits the task head lacks', prepare: (tree: string) => commit(tree, 'local.txt'), detail: /^the card tree \S+ at [0-9a-f]{40} is not behind the task head [0-9a-f]{40}, it has commits the head lacks; it is not brought to it$/ },
    { gap: 'uncommitted changes', prepare: (tree: string) => writeFileSync(path.join(tree, 'stray.txt'), 'a stray edit\n'), detail: /^the card tree \S+ at [0-9a-f]{40} has uncommitted changes; it is not brought to the task head [0-9a-f]{40}$/ },
    { gap: 'another branch checked out', prepare: (tree: string) => git(tree, 'checkout', '-q', '-b', 'feat/elsewhere'), detail: /^the card tree \S+ is on feat\/elsewhere, not feat\/card-1199; it is not brought to the task head [0-9a-f]{40}$/ },
  ])('an existing card tree with $gap is refused, the detail naming that gap alone, and no session runs', async ({ prepare, detail }) => {
    const round = await roundInAnExistingTree(prepare)
    expect(round.headsAtSpawn).toEqual([])
    expect(round.outcome).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed' } })
    expect(String(round.denials[0]?.detail)).toMatch(detail)
    expect(String(round.denials[0]?.detail)).toContain(round.head)
    round.close()
  })
})

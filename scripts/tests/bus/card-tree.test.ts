import type { AnswerRun } from '../../bus/answerer.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { AnswerExecutor } from '../../bus/answer-executor.js'
import { claudeAnswerer } from '../../bus/answerer.js'
import { gitCardTrees } from '../../bus/card-tree.js'
import { appendEvent } from '../../bus/db.js'
import { CARD_ANSWERED, CARD_STARTED, POLICY_DENIED } from '../../bus/inbox.js'
import { leaseNext } from '../../bus/lease.js'
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

describe('the card tree', () => {
  it('a deleted card tree is recreated from the pull request branch and the round starts', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-card-tree-'))
    const bench = mergeBench()
    const { repo, pushedHead } = origin(root)
    const tree = path.join(root, 'worktrees', 'mc-1199')
    git(repo, 'worktree', 'add', '-q', tree, BRANCH)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 1199, pr: null, head: null, dedupeKey: `${CARD_STARTED}:1199`, payload: { session: SESSION, worktree: tree, branch: BRANCH, base: sha('1') }, legacy: false })
    rmSync(tree, { recursive: true, force: true })
    const head = pushedHead()
    bench.gitHub.open({ number: 1099, review: 'failure', ref: BRANCH })
    bench.tick()

    const installed: string[] = []
    const runs: AnswerRun[] = []
    const answerer = claudeAnswerer(path.join(root, 'answers'), {
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
    const trees = { ...gitCardTrees(repo, path.join(root, 'worktrees'), (cwd: string) => installed.push(cwd)), branchOf: () => BRANCH }
    const executor = new AnswerExecutor({ db: bench.db, answerer, ownerMerges: () => '', clock: bench.clock.now, trees })

    const outcome = await executor.answer(leaseNext(bench.db, bench.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!)

    expect(outcome).toMatchObject({ kind: 'answered', session: SESSION, resumed: true })
    expect(existsSync(path.join(tree, 'round-1.txt'))).toBe(true)
    expect(git(tree, 'rev-parse', 'HEAD~1')).toBe(head)
    expect(git(tree, 'branch', '--show-current')).toBe(BRANCH)
    expect(installed).toEqual([tree])
    expect(runs.map(run => run.cwd)).toEqual([tree])
    expect(eventsOf(bench.db, CARD_ANSWERED)).toMatchObject([{ session: SESSION, resumed: true, from: head }])
    expect(eventsOf(bench.db, POLICY_DENIED)).toEqual([])
    bench.close()
    rmSync(root, { recursive: true, force: true })
  })
})

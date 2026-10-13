import type { DatabaseSync } from 'node:sqlite'
import type { CardTreeRemover } from '../../bus/close-executor.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARTIFACT_REMOVED, gitTreeRemover } from '../../bus/close-executor.js'
import { CloseWorker } from '../../bus/close-worker.js'
import { appendEvent } from '../../bus/db.js'
import { CARD_STARTED } from '../../bus/inbox.js'
import { BOARD_ALARM, CARD_CLOSED } from '../../bus/queue.js'
import { TREE_LEFT } from '../../bus/review-worker.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'

const PR = 993
const CARD = PR + 100
const SESSION = 'worker-1'
const CLOSER = `worker:close:${SESSION}`

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function repoWithCardTree(root: string): { repo: string, worktree: string } {
  const repo = path.join(root, 'repo')
  const worktree = path.join(root, `mc-${CARD}`)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(path.join(repo, 'README.md'), 'repo\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  git(repo, ['worktree', 'add', '-q', '-b', `feat/card-${CARD}`, worktree])
  return { repo, worktree: realpathSync(worktree) }
}

function listed(repo: string): string[] {
  return git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
}

function closeOnce(treesOf: CardTreeRemover | ((db: DatabaseSync) => CardTreeRemover), worktree: string | null, closedEarlier = false) {
  const bench = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'bus-close-tree-'))
  const trees = typeof treesOf === 'function' ? treesOf(bench.db) : treesOf
  try {
    if (worktree !== null)
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${CARD}`, payload: { session: 's', worktree, branch: `feat/card-${CARD}`, base: 'f'.repeat(40), pid: 1, pgid: 1 }, legacy: false })
    bench.gitHub.open({ number: PR })
    bench.tick()
    bench.gitHub.close(PR, true)
    bench.tick()
    if (closedEarlier)
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:earlier', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${CARD}`, payload: { verification: 'run' }, legacy: false })
    const worker = new CloseWorker({ db: bench.db, reported: () => 'run', clock: bench.clock.now, session: SESSION, journal: path.join(root, 'ghosts.jsonl'), parking: path.join(root, 'parking'), trees })
    const outcome = worker.step()
    if (outcome.kind === 'idle')
      throw new Error('the close queue held no task')
    return { outcome, closed: eventsOf(bench.db, CARD_CLOSED), removed: eventsOf(bench.db, ARTIFACT_REMOVED), alarms: eventsOf(bench.db, BOARD_ALARM), task: taskState(bench.db, outcome.taskKey) }
  }
  finally {
    bench.close()
    rmSync(root, { recursive: true, force: true })
  }
}

describe('the close executor removes the card tree it closed', () => {
  it('after card.closed the card tree is gone, git worktree list does not name it, and artifact.removed carries path, by and dirty', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'close-removes-tree-'))
    try {
      const { repo, worktree } = repoWithCardTree(root)
      writeFileSync(path.join(worktree, 'unsaved.txt'), 'left behind\n')
      expect(listed(repo).map(entry => realpathSync(entry))).toContain(worktree)

      const run = closeOnce(gitTreeRemover(repo), worktree)

      expect(run.outcome).toMatchObject({ kind: 'closed', verification: 'run' })
      expect(run.closed).toEqual([{ verification: 'run' }])
      expect(existsSync(worktree)).toBe(false)
      expect(listed(repo)).toHaveLength(1)
      expect(listed(repo).some(entry => entry.endsWith(`mc-${CARD}`))).toBe(false)
      expect(run.removed).toEqual([{ path: worktree, by: CLOSER, dirty: 1 }])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a card whose tree git worktree list no longer names closes and writes no artifact.removed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'close-removes-tree-'))
    try {
      const { repo, worktree } = repoWithCardTree(root)
      git(repo, ['worktree', 'remove', worktree])

      const run = closeOnce(gitTreeRemover(repo), worktree)

      expect(run.outcome).toMatchObject({ kind: 'closed' })
      expect(run.removed).toEqual([])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a card with no recorded tree closes without asking the remover', () => {
    const asked: string[] = []
    const run = closeOnce({ remove: (worktree) => {
      asked.push(worktree)
      return null
    } }, null)

    expect(run.outcome).toMatchObject({ kind: 'closed' })
    expect(asked).toEqual([])
    expect(run.removed).toEqual([])
  })

  it('the remover is asked only once card.closed is recorded in the bus', () => {
    const closedWhenAsked: number[] = []
    const run = closeOnce(db => ({ remove: () => {
      closedWhenAsked.push(eventsOf(db, CARD_CLOSED).length)
      return null
    } }), '/trees/mc-recorded')

    expect(run.outcome).toMatchObject({ kind: 'closed' })
    expect(closedWhenAsked).toEqual([1])
  })

  it('a close denied because the card is already closed never asks the remover', () => {
    const asked: string[] = []
    const run = closeOnce({ remove: (worktree) => {
      asked.push(worktree)
      return null
    } }, '/trees/mc-recorded', true)

    expect(run.outcome).toMatchObject({ kind: 'denied', denial: { reason: 'card_closed' } })
    expect(asked).toEqual([])
    expect(run.removed).toEqual([])
  })

  it('a removal that fails gives board.alarm tree_left with git\'s stderr, and the close is recorded and completed', () => {
    const run = closeOnce({ remove: () => {
      throw Object.assign(new Error('Command failed: git worktree remove'), { stderr: 'fatal: \'/trees/mc-gone\' contains modified or untracked files\n' })
    } }, '/trees/mc-gone')

    expect(run.outcome).toMatchObject({ kind: 'closed' })
    expect(run.closed).toEqual([{ verification: 'run' }])
    expect(run.task).toMatchObject({ state: 'completed', failures: 0 })
    expect(run.removed).toEqual([])
    expect(run.alarms).toEqual([{ reason: TREE_LEFT, path: '/trees/mc-gone', detail: 'fatal: \'/trees/mc-gone\' contains modified or untracked files' }])
  })
})

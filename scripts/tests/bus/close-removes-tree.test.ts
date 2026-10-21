import type { DatabaseSync } from 'node:sqlite'
import type { CardTreeRemover } from '../../bus/close-executor.js'
import type { CloseNodeParts } from '../../bus/close-worker.js'
import type { EndedTree } from '../../bus/ended-card-trees.js'
import type { NodeStep } from '../../bus/node.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { gitTreeRemover } from '../../bus/close-executor.js'
import { CloseNode } from '../../bus/close-worker.js'
import { appendEvent } from '../../bus/db.js'
import { TREE_LEFT } from '../../bus/review-worker.js'
import { ARTIFACT_KEPT, ARTIFACT_REMOVED, BOARD_ALARM, CARD_CLOSED, CARD_STARTED } from '../../core/events.js'
import { detectClose } from './close-detection.js'
import { cardVerified, eventsOf, mergeBench, taskState } from './merge-bench.js'

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

function closeNode(parts: Omit<CloseNodeParts, 'mode' | 'env'>): CloseNode {
  return new CloseNode({ ...parts, mode: 'shadow', env: {} })
}

async function step(node: CloseNode): Promise<NodeStep | null> {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  return node.getState().lastStep
}

async function closeOnce(treesOf: CardTreeRemover | ((db: DatabaseSync) => CardTreeRemover), worktree: string | null, closedEarlier = false, endedTrees?: () => EndedTree[]) {
  const bench = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'bus-close-tree-'))
  const trees = typeof treesOf === 'function' ? treesOf(bench.db) : treesOf
  try {
    if (worktree !== null)
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${CARD}`, payload: { session: 's', worktree, branch: `feat/card-${CARD}`, base: 'f'.repeat(40), pid: 1, pgid: 1 }, legacy: false })
    bench.gitHub.open({ number: PR })
    bench.tick()
    cardVerified(bench.db, bench.clock.now().toISOString(), CARD, PR)
    bench.gitHub.close(PR, true)
    bench.tick()
    detectClose(bench.db, bench.clock.now)
    if (closedEarlier)
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:earlier', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${CARD}`, payload: { verification: 'run' }, legacy: false })
    const worker = closeNode({ db: bench.db, reported: () => 'run', clock: bench.clock.now, session: SESSION, journal: path.join(root, 'ghosts.jsonl'), parking: path.join(root, 'parking'), trees, endedTrees })
    const outcome = await step(worker)
    if (outcome === null || outcome.kind === 'idle' || outcome.taskKey === undefined)
      throw new Error('the close queue held no task')
    return { outcome, closed: eventsOf(bench.db, CARD_CLOSED), removed: eventsOf(bench.db, ARTIFACT_REMOVED), kept: eventsOf(bench.db, ARTIFACT_KEPT), alarms: eventsOf(bench.db, BOARD_ALARM), task: taskState(bench.db, outcome.taskKey) }
  }
  finally {
    bench.close()
    rmSync(root, { recursive: true, force: true })
  }
}

describe('the close executor removes the card tree it closed', () => {
  it('after card.closed a clean card tree is gone, git worktree list does not name it, and artifact.removed carries path, by and dirty 0', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'close-removes-tree-'))
    try {
      const { repo, worktree } = repoWithCardTree(root)
      expect(listed(repo).map(entry => realpathSync(entry))).toContain(worktree)

      const run = await closeOnce(gitTreeRemover(repo), worktree)

      expect(run.outcome).toMatchObject({ kind: 'closed', verification: 'run' })
      expect(run.closed).toEqual([{ verification: 'run' }])
      expect(existsSync(worktree)).toBe(false)
      expect(listed(repo)).toHaveLength(1)
      expect(listed(repo).some(entry => entry.endsWith(`mc-${CARD}`))).toBe(false)
      expect(run.removed).toEqual([{ path: worktree, by: CLOSER, dirty: 0 }])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('close keeps a card tree with a changed tracked file, writes artifact.kept with its dirty count and completes, and still removes a clean tree', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'close-removes-tree-'))
    try {
      const { repo, worktree } = repoWithCardTree(root)
      writeFileSync(path.join(worktree, 'README.md'), 'edited\n')

      const run = await closeOnce(gitTreeRemover(repo), worktree)

      expect(run.outcome).toMatchObject({ kind: 'closed', verification: 'run' })
      expect(run.task).toMatchObject({ state: 'completed', failures: 0 })
      expect(existsSync(worktree)).toBe(true)
      expect(listed(repo)).toHaveLength(2)
      expect(run.removed).toEqual([])
      expect(run.kept).toEqual([{ path: worktree, by: CLOSER, dirty: 1 }])
      git(repo, ['worktree', 'remove', '--force', worktree])

      const clean = repoWithCardTree(mkdtempSync(path.join(tmpdir(), 'close-removes-tree-')))
      const cleanRun = await closeOnce(gitTreeRemover(clean.repo), clean.worktree)
      expect(existsSync(clean.worktree)).toBe(false)
      expect(cleanRun.kept).toEqual([])
      expect(cleanRun.removed).toEqual([{ path: clean.worktree, by: CLOSER, dirty: 0 }])
      rmSync(path.dirname(clean.repo), { recursive: true, force: true })
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('close keeps a card tree whose only change is an untracked file and writes artifact.kept with dirty 1', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'close-removes-tree-'))
    try {
      const { repo, worktree } = repoWithCardTree(root)
      writeFileSync(path.join(worktree, 'unsaved.txt'), 'left behind\n')

      const run = await closeOnce(gitTreeRemover(repo), worktree)

      expect(run.task).toMatchObject({ state: 'completed', failures: 0 })
      expect(existsSync(path.join(worktree, 'unsaved.txt'))).toBe(true)
      expect(run.removed).toEqual([])
      expect(run.kept).toEqual([{ path: worktree, by: CLOSER, dirty: 1 }])
      git(repo, ['worktree', 'remove', '--force', worktree])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a card whose tree git worktree list no longer names closes and writes no artifact.removed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'close-removes-tree-'))
    try {
      const { repo, worktree } = repoWithCardTree(root)
      git(repo, ['worktree', 'remove', worktree])

      const run = await closeOnce(gitTreeRemover(repo), worktree)

      expect(run.outcome).toMatchObject({ kind: 'closed' })
      expect(run.removed).toEqual([])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a card with no recorded tree closes without asking the remover', async () => {
    const asked: string[] = []
    const run = await closeOnce({ remove: (worktree) => {
      asked.push(worktree)
      return null
    } }, null)

    expect(run.outcome).toMatchObject({ kind: 'closed' })
    expect(asked).toEqual([])
    expect(run.removed).toEqual([])
  })

  it('the remover is asked only once card.closed is recorded in the bus', async () => {
    const closedWhenAsked: number[] = []
    const run = await closeOnce(db => ({ remove: () => {
      closedWhenAsked.push(eventsOf(db, CARD_CLOSED).length)
      return null
    } }), '/trees/mc-recorded')

    expect(run.outcome).toMatchObject({ kind: 'closed' })
    expect(closedWhenAsked).toEqual([1])
  })

  it('a close denied because the card is already closed never asks the remover', async () => {
    const asked: string[] = []
    const run = await closeOnce({ remove: (worktree) => {
      asked.push(worktree)
      return null
    } }, '/trees/mc-recorded', true)

    expect(run.outcome).toMatchObject({ kind: 'denied', denial: { reason: 'card_closed' } })
    expect(asked).toEqual([])
    expect(run.removed).toEqual([])
  })

  it('a removal that fails gives board.alarm tree_left with git\'s stderr, and the close is recorded and completed', async () => {
    const run = await closeOnce({ remove: () => {
      throw Object.assign(new Error('Command failed: git worktree remove'), { stderr: 'fatal: \'/trees/mc-gone\' contains modified or untracked files\n' })
    } }, '/trees/mc-gone')

    expect(run.outcome).toMatchObject({ kind: 'closed' })
    expect(run.closed).toEqual([{ verification: 'run' }])
    expect(run.task).toMatchObject({ state: 'completed', failures: 0 })
    expect(run.removed).toEqual([])
    expect(run.alarms).toEqual([{ reason: TREE_LEFT, path: '/trees/mc-gone', detail: 'fatal: \'/trees/mc-gone\' contains modified or untracked files' }])
  })

  it('a pass over ended cards\' trees that throws does not stop the close: the card is closed and the task completed', async () => {
    const run = await closeOnce({ remove: () => null }, '/trees/mc-recorded', false, () => {
      throw Object.assign(new Error('Command failed: git worktree list'), { stderr: 'fatal: not a git repository' })
    })

    expect(run.outcome).toMatchObject({ kind: 'closed' })
    expect(run.closed).toEqual([{ verification: 'run' }])
    expect(run.task).toMatchObject({ state: 'completed', failures: 0 })
  })
})

import type { CardTreeRemover } from '../../bus/close-executor.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARTIFACT_REMOVED, CloseExecutor, gitTreeRemover } from '../../bus/close-executor.js'
import { appendEvent } from '../../bus/db.js'
import { CARD_STARTED } from '../../bus/inbox.js'
import { leaseNext } from '../../bus/lease.js'
import { CARD_CLOSED } from '../../bus/queue.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'

const PR = 993
const CARD = PR + 100
const CLOSER = 'worker:close:worker-1'

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

function closeOnce(trees: CardTreeRemover, worktree: string | null) {
  const bench = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'bus-close-tree-'))
  try {
    if (worktree !== null)
      appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${CARD}`, payload: { session: 's', worktree, branch: `feat/card-${CARD}`, base: 'f'.repeat(40), pid: 1, pgid: 1 }, legacy: false })
    bench.gitHub.open({ number: PR })
    bench.tick()
    bench.gitHub.close(PR, true)
    bench.tick()
    const executor = new CloseExecutor({ db: bench.db, reported: () => 'run', clock: bench.clock.now, journal: path.join(root, 'ghosts.jsonl'), parking: path.join(root, 'parking'), trees })
    const lease = leaseNext(bench.db, bench.clock.now().toISOString(), 'close', CLOSER)!
    const outcome = executor.close(lease)
    return { outcome, closed: eventsOf(bench.db, CARD_CLOSED), removed: eventsOf(bench.db, ARTIFACT_REMOVED), task: taskState(bench.db, lease.taskKey) }
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

  it('a removal that fails leaves the close recorded and completed, for the sweeper to finish', () => {
    const run = closeOnce({ remove: () => {
      throw new Error('git worktree remove failed')
    } }, '/trees/mc-gone')

    expect(run.outcome).toMatchObject({ kind: 'closed' })
    expect(run.closed).toEqual([{ verification: 'run' }])
    expect(run.task).toMatchObject({ state: 'completed', failures: 0 })
    expect(run.removed).toEqual([])
  })
})

import type { DatabaseSync } from 'node:sqlite'
import type { CardStarter } from '../../nodes/launch/launch-executor.js'
import type { TreeTools } from '../../nodes/review/reviewer.js'
import type { DiskReader } from '../../ports/disk.js'
import type { StatusPublisher } from '../../ports/github-status.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { TreeOrigin } from '../../ports/worktree.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { gitTreeRemover } from '../../nodes/close/close-executor.js'
import { LaunchExecutor } from '../../nodes/launch/launch-executor.js'
import { CutTreeOrigins } from '../../nodes/launch/launch-root.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { ReviewWorker } from '../../nodes/review/review-worker.js'
import { claudeReviewer, GIT_TREE_TOOLS, ReviewTrees } from '../../nodes/review/reviewer.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { NetWatch, TICK_MS } from '../../ports/netwatch.js'
import { cutTree, FREE_TREE_CAPACITY, treeOriginIn, treeOriginLine } from '../../ports/worktree.js'
import { busProjections } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { BusTick } from '../../supervisor/run.js'
import { Clock, FakeGitHub } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'
import { detectReview } from './review-detection.js'

const FIRST = 1701
const SECOND = 1702
const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })
const roomy: DiskReader = () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES })

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tree-origin-')))
  roots.push(root)
  return root
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function clonedRepo(root: string): string {
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  git(repo, ['checkout', '-q', '-b', 'main'])
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.construct/\n')
  writeFileSync(path.join(repo, 'README.md'), 'readme\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'first'])
  git(repo, ['push', '-q', 'origin', 'main'])
  return repo
}

function cardStartedPayload(worktree: string, origin: TreeOrigin): Record<string, unknown> {
  const origins = new CutTreeOrigins()
  origins.note(worktree, treeOriginLine(origin))
  const starter: CardStarter = {
    start: () => ({ kind: 'started', card: { session: 's-1', worktree, branch: 'feat/card', base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }),
    stop: () => {},
  }
  const bench = mergeBench()
  const ts = bench.clock.now().toISOString()
  appendEvent(bench.db, { ts, type: CARD_ADMITTED, actor: 'policy', cardId: FIRST, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${FIRST}`, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${FIRST}` }, legacy: false })
  bench.tick()
  const lease = leaseNext(bench.db, bench.clock.now().toISOString(), 'launch', 'worker:launch:worker-1')!
  new LaunchExecutor({ silentMs: SILENT_MS, db: bench.db, starter, clock: bench.clock.now, disk: roomy, isolation: sandboxed, treeOrigin: origins.take }).launch(lease)
  const [started] = eventsOf(bench.db, CARD_STARTED)
  bench.close()
  return started!
}

function reviewBench(root: string): { db: DatabaseSync, gitHub: FakeGitHub, tick: () => void, worker: (reviewer: ReturnType<typeof claudeReviewer>) => ReviewWorker } {
  const db = openBus(path.join(root, 'bus.db'))
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const busTick = new BusTick(db, busProjections(), new NetWatch(db, gitHub.client, clock.now), clock.now)
  const publish: StatusPublisher = () => {}
  return {
    db,
    gitHub,
    tick: () => {
      busTick.run()
      detectReview({ db, gitHub, clock })
      clock.advance(TICK_MS)
    },
    worker: reviewer => new ReviewWorker({ silentMs: SILENT_MS, db, gitHub: gitHub.client, publish, reviewer, plan: () => fullReview('a fixed plan'), clock: clock.now, session: 'worker-1', isolation: sandboxed }),
  }
}

function localTrees(): TreeTools {
  return {
    ...GIT_TREE_TOOLS,
    prepare: () => {},
    freeTrees: FREE_TREE_CAPACITY,
    git: (cwd, args) => {
      if (args[0] !== 'fetch')
        GIT_TREE_TOOLS.git(cwd, args)
    },
  }
}

describe('the origin of a tree is recorded on the event that starts its work', () => {
  it('a card start from a free tree records reused and a cut tree records cut', () => {
    const root = tempRoot()
    const repo = clonedRepo(root)
    const home = path.join(root, 'bus', 'worktrees')
    const deps = { cwd: repo, git, install: () => {}, exists: existsSync, treeOf: (id: string) => path.join(home, id) }

    const first = cutTree(deps, String(FIRST), `feat/card-${FIRST}`)
    if ('refused' in first)
      throw new Error(first.refused)
    expect(first.origin).toBe('cut')
    expect(treeOriginIn(`noise\n${treeOriginLine(first.origin!)}\n`)).toBe('cut')
    expect(cardStartedPayload(first.worktree, first.origin!)).toMatchObject({ tree_origin: 'cut' })

    gitTreeRemover(repo, FREE_TREE_CAPACITY).remove(first.worktree, true)
    const second = cutTree(deps, String(SECOND), `feat/card-${SECOND}`)
    if ('refused' in second)
      throw new Error(second.refused)
    expect(second.origin).toBe('reused')
    expect(cardStartedPayload(second.worktree, second.origin!)).toMatchObject({ tree_origin: 'reused' })
  })

  it('an output with no origin line notes nothing and a noted origin is taken once', () => {
    const origins = new CutTreeOrigins()
    origins.note('/trees/a', 'output with no origin line')
    expect(origins.take('/trees/a')).toBeNull()
    origins.note('/trees/a', treeOriginLine('cut'))
    expect(origins.take('/trees/a')).toBe('cut')
    expect(origins.take('/trees/a')).toBeNull()
  })

  it('a recorded review names the origin of its tree', async () => {
    const root = tempRoot()
    const repo = clonedRepo(root)
    const head = git(repo, ['rev-parse', 'HEAD']).trim()
    const dir = path.join(root, 'reviews')
    const { db, gitHub, tick, worker } = reviewBench(root)
    const reviewer = claudeReviewer(new ReviewTrees(repo, dir, localTrees()), async (params) => {
      writeFileSync(params.stdoutPath, '')
      writeFileSync(path.join(dir, `${params.sessionId}.verdict.json`), '{"verdict":"pass","findings":[]}')
      return 0
    })

    gitHub.open({ number: 961, head })
    tick()
    expect(await worker(reviewer).step()).toMatchObject({ kind: 'recorded', verdict: 'pass' })
    gitHub.open({ number: 962, head })
    tick()
    expect(await worker(reviewer).step()).toMatchObject({ kind: 'recorded', verdict: 'pass' })

    expect(eventsOf(db, 'review.recorded').map(event => event.tree_origin)).toEqual(['cut', 'reused'])
    db.close()
  })
})

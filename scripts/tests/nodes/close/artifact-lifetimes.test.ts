import type { ProcessCwds } from '../../../ports/client/contract.js'
import type { MergeBench } from '../../bus/merge-bench.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { busDirOf } from '../../../core/bus-path.js'
import { appendEvent } from '../../../core/db.js'
import { ARTIFACT_REMOVED, BOARD_ALARM, CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_STARTED } from '../../../core/events.js'
import { reduce } from '../../../core/reducer.js'
import { ARTIFACT_LIFETIMES, ENDED_TREE_PATCH_DAYS, HOME_OVER_BUDGET, recordFreedArtifacts, rootOf, rootSizes, rowOfRoot, sweepArtifacts } from '../../../nodes/close/artifact-lifetimes.js'
import { CloseNode } from '../../../nodes/close/close-worker.js'
import { cardTreeSweep, gitWorktrees, recordEndedTrees } from '../../../nodes/close/ended-card-trees.js'
import { dryRunReviewsDir, keepDryRun } from '../../../nodes/review/dry-run-record.js'
import { reviewsDir } from '../../../nodes/review/review-worker.js'
import { busWorktreeHome, cardTreeRoots, DEFAULT_WORKTREE_HOME } from '../../../ports/worktree-home.js'
import { busProjections } from '../../../supervisor/composition.js'
import { eventsOf, mergeBench } from '../../bus/merge-bench.js'

const CARD = 2144
const PROBE_CARD = 2150
const OPEN_PROBE_CARD = 2151
const SWEEPER = 'worker:close:pass'
const NO_LIVE_SESSION: () => ProcessCwds = () => ({ kind: 'listed', cwds: [] })
const TASK_CLOSE = fileURLToPath(new URL('../../../nodes/close/task-close.ts', import.meta.url))
const DAY_MS = 24 * 60 * 60 * 1000

let root: string
let home: string
let bus: string
let busDir: string
let repo: string
let bench: MergeBench

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function at(): string {
  return bench.clock.now().toISOString()
}

function places(): { home: string, busDir: string } {
  return { home, busDir }
}

function realHomePlaces(): { home: string, busDir: string } {
  const construct = path.join(os.homedir(), '.construct')
  return { home: construct, busDir: busDirOf(path.join(construct, 'bus.db')) }
}

function reportRootsOfTaskClose(): string[] {
  const declared = /const REPORT_ROOTS = \[([^\]]*)\]/.exec(readFileSync(TASK_CLOSE, 'utf8'))?.[1]
  if (declared === undefined)
    throw new Error('task-close.ts declares no REPORT_ROOTS')
  return [...declared.matchAll(/'([^']+)'/g)].map(match => match[1]!)
}

function startedTree(cardId: number): string {
  const tree = path.join(busWorktreeHome(bus), String(cardId))
  git(repo, ['worktree', 'add', '-q', '-b', `feat/card-${cardId}`, tree])
  writeFileSync(path.join(tree, 'work.txt'), 'work\n')
  appendEvent(bench.db, { ts: at(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { card: `#${cardId} part [implement/netwatch/S/cheap/auto] · depends — · blocks —`, lane: null, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
  appendEvent(bench.db, { ts: at(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${cardId}`, payload: { session: `s-${cardId}`, worktree: realpathSync(tree), branch: `feat/card-${cardId}`, base: 'f'.repeat(40), pid: 1, pgid: 1 }, legacy: false })
  appendEvent(bench.db, { ts: at(), type: CARD_DROPPED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:${cardId}`, payload: { lane: 'dropped', reason: 'superseded' }, legacy: false })
  reduce(bench.db, 'pending', busProjections())
  return realpathSync(tree)
}

function dryRunTree(session: string, verdictKept: boolean): string {
  const dir = dryRunReviewsDir(busDir)
  const tree = path.join(dir, session)
  git(repo, ['worktree', 'add', '-q', '--detach', tree])
  if (verdictKept)
    keepDryRun(dir)(session, { pr: 1755, head: 'a'.repeat(40) })
  return tree
}

function probe(cardId: number, name: string): { dir: string, report: string, copy: string } {
  const dir = path.join(home, 'probes', `${cardId}-${name}`)
  const copy = path.join(dir, 'repo-copy')
  mkdirSync(path.join(copy, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(path.join(copy, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  mkdirSync(path.join(dir, 'out'), { recursive: true })
  const report = path.join(dir, 'out', 'report.md')
  writeFileSync(report, '# report\n')
  writeFileSync(path.join(dir, 'out', 'scratch.log'), 'noise\n')
  return { dir, report, copy }
}

function probeClosed(cardId: number, report: string): void {
  appendEvent(bench.db, { ts: at(), type: CARD_CLOSED, actor: 'worker:close:c-1', cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { verification: 'run', report }, legacy: false })
}

function savedPatch(cardId: number, ageDays: number): string {
  const saved = path.join(busDir, 'probes', 'ended-trees', String(cardId))
  mkdirSync(saved, { recursive: true })
  writeFileSync(path.join(saved, 'tree.patch'), 'diff\n')
  const then = new Date(bench.clock.now().getTime() - ageDays * DAY_MS)
  utimesSync(saved, then, then)
  return saved
}

function closeNode(sizes: (home: string) => { path: string, bytes: number }[], budget: number): CloseNode {
  return new CloseNode({ silentMs: 60_000, db: bench.db, reported: () => 'run', clock: bench.clock.now, session: 'node-1', parking: path.join(root, 'parking'), mode: 'live', env: {}, trees: { remove: () => null }, home: { path: home, budget, everyMs: 60_000, sizes } })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'artifact-lifetimes-')))
  home = path.join(root, '.construct')
  bus = path.join(home, 'bus.db')
  busDir = busDirOf(bus)
  repo = path.join(root, 'repo')
  mkdirSync(home, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(path.join(repo, 'README.md'), 'repo\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  bench = mergeBench()
})

afterEach(() => {
  bench.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the artifact lifetime table', () => {
  it('every root the factory writes under the construct home has an owner and an end', () => {
    const real = realHomePlaces()
    const busPath = path.join(real.home, 'bus.db')
    const saves: string[] = []
    const tree = startedTree(CARD)
    const capturing = { ...gitWorktrees(repo), save: (_tree: string, into: string) => {
      saves.push(into)
      return { patch: null, branch: null }
    } }
    cardTreeSweep(bench.db, {}, bus, repo, capturing, bench.clock.now, NO_LIVE_SESSION).free()
    expect(saves).toHaveLength(1)
    expect(existsSync(tree)).toBe(false)

    const built: { root: string, at: { home: string, busDir: string } }[] = [
      { root: busWorktreeHome(busPath), at: real },
      { root: DEFAULT_WORKTREE_HOME, at: real },
      ...cardTreeRoots({}, busPath, repo).homes.filter(each => each.startsWith(real.home + path.sep)).map(each => ({ root: each, at: real })),
      { root: reviewsDir(real.busDir, { kind: 'on' }), at: real },
      { root: reviewsDir(real.busDir, { kind: 'dry-run', pr: 1 }), at: real },
      { root: dryRunReviewsDir(real.busDir), at: real },
      { root: path.dirname(saves[0]!), at: places() },
      ...reportRootsOfTaskClose().map(name => ({ root: path.join(real.home, name), at: real })),
    ]

    const unowned = built.filter(each => rowOfRoot(each.root, each.at) === null).map(each => each.root)
    expect(unowned).toEqual([])
    for (const row of ARTIFACT_LIFETIMES) {
      expect(row.owner).not.toBe('')
      expect(row.end).not.toBe('')
    }
    expect(new Set(ARTIFACT_LIFETIMES.map(row => rootOf(row, real))).size).toBe(ARTIFACT_LIFETIMES.length)
  })

  it('the sweep frees each artifact kind once its end is recorded', () => {
    const cardTree = startedTree(CARD)
    const reviewed = dryRunTree('reviewed', true)
    const reviewing = dryRunTree('reviewing', false)
    const closed = probe(PROBE_CARD, 'lab')
    const open = probe(OPEN_PROBE_CARD, 'lab')
    probeClosed(PROBE_CARD, closed.report)
    const expired = savedPatch(77, ENDED_TREE_PATCH_DAYS + 1)
    const fresh = savedPatch(78, 1)

    recordEndedTrees(bench.db, SWEEPER, at(), cardTreeSweep(bench.db, {}, bus, repo, gitWorktrees(repo), bench.clock.now, NO_LIVE_SESSION).free())
    const freed = sweepArtifacts(bench.db, places(), gitWorktrees(repo), bench.clock.now())
    recordFreedArtifacts(bench.db, SWEEPER, at(), freed)

    expect(existsSync(cardTree)).toBe(false)
    expect(existsSync(path.join(busDir, 'probes', 'ended-trees', String(CARD), 'tree.patch'))).toBe(true)
    expect(existsSync(reviewed)).toBe(false)
    expect(existsSync(path.join(dryRunReviewsDir(busDir), 'reviewed.dry-run.json'))).toBe(true)
    expect(existsSync(reviewing)).toBe(true)
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(reviewed)
    expect(readFileSync(closed.report, 'utf8')).toBe('# report\n')
    expect(existsSync(closed.copy)).toBe(false)
    expect(existsSync(path.join(closed.dir, 'out', 'scratch.log'))).toBe(false)
    expect(existsSync(open.copy)).toBe(true)
    expect(existsSync(expired)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(freed.filter(each => each.left !== null)).toEqual([])
    const removed = eventsOf(bench.db, ARTIFACT_REMOVED).map(payload => payload.path)
    expect(removed).toEqual(expect.arrayContaining([cardTree, reviewed, closed.copy, path.join(closed.dir, 'out', 'scratch.log'), expired]))
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
  })

  it('a construct home over its size budget raises one board alarm naming the largest roots', () => {
    mkdirSync(path.join(home, 'bus', 'worktrees', '1'), { recursive: true })
    writeFileSync(path.join(home, 'bus', 'worktrees', '1', 'big.bin'), Buffer.alloc(3000))
    mkdirSync(path.join(home, 'probes', '9-lab'), { recursive: true })
    writeFileSync(path.join(home, 'probes', '9-lab', 'mid.bin'), Buffer.alloc(2000))
    writeFileSync(path.join(home, 'bus.db'), Buffer.alloc(100))
    const sizes = rootSizes(home)
    expect(sizes.map(each => path.basename(each.path))).toEqual(['bus', 'probes', 'bus.db'])

    const under = closeNode(rootSizes, 10_000)
    under.measureHome()
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])

    const node = closeNode(rootSizes, 4000)
    node.measureHome()
    bench.clock.advance(120_000)
    node.measureHome()

    const alarms = eventsOf(bench.db, BOARD_ALARM)
    expect(alarms).toHaveLength(1)
    expect(alarms[0]).toMatchObject({ reason: HOME_OVER_BUDGET, path: home })
    const detail = String(alarms[0]!.detail)
    expect(detail.indexOf(path.join(home, 'bus'))).toBeGreaterThan(-1)
    expect(detail.indexOf(path.join(home, 'bus'))).toBeLessThan(detail.indexOf(path.join(home, 'probes')))
  })
})

import type { WorktreeGit } from '../../../nodes/close/ended-card-trees.js'
import type { ProcessCwds } from '../../../ports/client/contract.js'
import type { MergeBench } from '../../bus/merge-bench.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { busDirOf } from '../../../core/bus-path.js'
import { RUNNING_CARD } from '../../../core/card-automaton.js'
import { appendEvent } from '../../../core/db.js'
import { ARTIFACT_REMOVED, BOARD_ALARM, CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_STARTED } from '../../../core/events.js'
import { leaseNext } from '../../../core/lease.js'
import { TREE_LEFT } from '../../../core/node.js'
import { all as pullRequests } from '../../../core/pr-readings.js'
import { reduce } from '../../../core/reducer.js'
import { ARTIFACT_LIFETIMES, ENDED_TREE_PATCH_DAYS, HOME_OVER_BUDGET, recordFreedArtifacts, rootOf, rootSizes, rowOfRoot, sweepArtifacts } from '../../../nodes/close/artifact-lifetimes.js'
import { CloseNode, closeNodeOf } from '../../../nodes/close/close-worker.js'
import { cardTreeSweep, DIRTY, EndedCardTrees, gitWorktrees, recordEndedTrees, TREE_PATCH, UNSAVED } from '../../../nodes/close/ended-card-trees.js'
import { dryRunReviewsDir, keepDryRun } from '../../../nodes/review/dry-run-record.js'
import { reviewsDir } from '../../../nodes/review/review-worker.js'
import { gitWitnessTrees } from '../../../nodes/witness/witness-executor.js'
import { busWorktreeHome, cardTreeRoots, DEFAULT_WORKTREE_HOME } from '../../../ports/worktree-home.js'
import { busProjections } from '../../../supervisor/composition.js'
import { detectClose } from '../../bus/close-detection.js'
import { cardVerified, eventsOf, mergeBench } from '../../bus/merge-bench.js'

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
  it('every root the factory writes under the construct home has an owner and an end', async () => {
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

    const witnessRun = await gitWitnessTrees(repo).withTree(git(repo, ['rev-parse', 'HEAD']).trim(), async tree => tree)
    expect(witnessRun.startsWith(real.home + path.sep)).toBe(false)
    expect(witnessRun.startsWith(home + path.sep)).toBe(false)
    expect(existsSync(witnessRun)).toBe(false)
    expect(listed(repo)).not.toContain(witnessRun)
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

  it('the construct home is walked at most once per measuring interval', () => {
    const walks: string[] = []
    const node = closeNode((walked) => {
      walks.push(walked)
      return []
    }, 4000)

    node.measureHome()
    bench.clock.advance(30_000)
    node.measureHome()
    expect(walks).toEqual([home])

    bench.clock.advance(30_000)
    node.measureHome()
    expect(walks).toEqual([home, home])
  })

  it('the close node pass runs the artifact sweep and records what it freed', async () => {
    const reviewed = dryRunTree('reviewed', true)
    const node = new CloseNode({ silentMs: 60_000, db: bench.db, reported: () => 'run', clock: bench.clock.now, session: 'node-1', parking: path.join(root, 'parking'), mode: 'live', env: {}, trees: { remove: () => null }, artifacts: () => sweepArtifacts(bench.db, places(), gitWorktrees(repo), bench.clock.now()) })

    await node.run({ pause: async () => {}, signal: AbortSignal.abort() })

    expect(existsSync(reviewed)).toBe(false)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED).map(payload => payload.path)).toEqual([reviewed])
  })

  it('a closed probe whose report lies outside its directory is left whole', () => {
    const outside = probe(PROBE_CARD, 'elsewhere')
    const report = path.join(home, 'reports', 'probe.md')
    mkdirSync(path.dirname(report), { recursive: true })
    writeFileSync(report, '# report\n')
    probeClosed(PROBE_CARD, report)

    const freed = sweepArtifacts(bench.db, places(), gitWorktrees(repo), bench.clock.now())

    expect(freed).toEqual([])
    expect(existsSync(outside.copy)).toBe(true)
    expect(existsSync(path.join(outside.dir, 'out', 'scratch.log'))).toBe(true)
    expect(readFileSync(report, 'utf8')).toBe('# report\n')
  })

  it('a dry-run tree git refuses to remove is deleted as a directory and its worktree entry is pruned', () => {
    const reviewed = dryRunTree('reviewed', true)
    const refusing = { ...gitWorktrees(repo), remove: () => {
      throw new Error('fatal: Directory not empty')
    } }

    const freed = sweepArtifacts(bench.db, places(), refusing, bench.clock.now())

    expect(freed.map(each => ({ path: each.path, left: each.left }))).toEqual([{ path: reviewed, left: null }])
    expect(existsSync(reviewed)).toBe(false)
    expect(listed(repo)).not.toContain(reviewed)
  })

  it('the close worker entry wires the artifact sweep and the size budget into its node', async () => {
    const reviewed = dryRunTree('reviewed', true)
    writeFileSync(path.join(home, 'bus.db'), Buffer.alloc(5000))
    const run = { busPath: bus, reported: () => 'run', session: 'node-1', parking: path.join(root, 'parking'), pause: async () => {}, artifacts: () => () => sweepArtifacts(bench.db, places(), gitWorktrees(repo), bench.clock.now()), home: { path: home, budget: 1000, everyMs: 60_000 } }

    await closeNodeOf(run, bench.db, 'live', bench.clock.now).run({ pause: async () => {}, signal: AbortSignal.abort() })

    expect(existsSync(reviewed)).toBe(false)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED).map(payload => payload.path)).toEqual([reviewed])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([expect.objectContaining({ reason: HOME_OVER_BUDGET, path: home })])
  })
})

const CLOSED = 836
const CLOSED_BESIDE_REPO = 837
const RUNNING = 872
const UNRECORDED = 913
const CLOSER = 'worker:close:pass'

function listed(repo: string): string[] {
  return git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
}

function linkedCardTree(cardId: number, home = root, name = `mc-${cardId}`): string {
  const tree = path.join(home, name)
  git(repo, ['worktree', 'add', '-q', '-b', `feat/card-${cardId}`, tree])
  return realpathSync(tree)
}

function startedIn(cardId: number, worktree: string): void {
  const ts = bench.clock.now().toISOString()
  appendEvent(bench.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { card: `#${cardId} part [implement/netwatch/S/cheap/auto] · depends — · blocks —`, lane: null, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
  appendEvent(bench.db, { ts, type: CARD_STARTED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${cardId}`, payload: { session: `s-${cardId}`, worktree, branch: `feat/card-${cardId}`, base: 'f'.repeat(40), pid: 1, pgid: 1 }, legacy: false })
  reduce(bench.db, 'pending', busProjections())
}

function closeLeased(cardId: number): void {
  const pr = cardId - 100
  bench.gitHub.open({ number: pr })
  bench.tick()
  cardVerified(bench.db, bench.clock.now().toISOString(), cardId, pr)
  bench.gitHub.close(pr, true)
  bench.tick()
  detectClose(bench.db, bench.clock.now)
  expect(leaseNext(bench.db, pullRequests(bench.db), bench.clock.now().toISOString(), 'close', 'worker:close:other')).toMatchObject({ cardId })
}

function closedCard(cardId: number): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { verification: 'run' }, legacy: false })
}

function treesBusDir(): string {
  return path.join(root, 'bus')
}

function savedTreePatch(cardId: number): string {
  return path.join(treesBusDir(), 'probes', 'ended-trees', String(cardId), TREE_PATCH)
}

function sweepPass(trees: WorktreeGit = gitWorktrees(repo)): void {
  const ended = new EndedCardTrees(bench.db, [root], trees, bench.clock.now, [], undefined, treesBusDir()).free()
  recordEndedTrees(bench.db, CLOSER, bench.clock.now().toISOString(), ended)
}

describe('the close worker frees the trees of ended cards', () => {
  beforeEach(() => {
    writeFileSync(path.join(repo, 'package.json'), '{}\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'package'])
  })

  it('a closed card\'s half-deleted tree is removed by the pass without a new close, and artifact.removed carries path and by', () => {
    const tree = linkedCardTree(CLOSED)
    unlinkSync(path.join(tree, 'README.md'))
    startedIn(CLOSED, tree)
    closedCard(CLOSED)

    sweepPass()

    expect(existsSync(tree)).toBe(false)
    expect(listed(repo)).toHaveLength(1)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([{ path: tree, by: CLOSER }])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
  })

  it('a half-deleted tree git refuses to remove is deleted as a directory and pruned', () => {
    const tree = linkedCardTree(CLOSED)
    unlinkSync(path.join(tree, 'README.md'))
    startedIn(CLOSED, tree)
    closedCard(CLOSED)
    const real = gitWorktrees(repo)

    sweepPass({ ...real, remove: () => {
      throw Object.assign(new Error('git failed'), { stderr: 'fatal: Directory not empty' })
    } })

    expect(existsSync(tree)).toBe(false)
    expect(listed(repo)).toHaveLength(1)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([{ path: tree, by: CLOSER }])
  })

  it('the tree of a card in work is left untouched', () => {
    const tree = linkedCardTree(RUNNING)
    startedIn(RUNNING, tree)
    expect(bench.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(RUNNING)).toEqual({ state: RUNNING_CARD })

    sweepPass()

    expect(existsSync(path.join(tree, 'README.md'))).toBe(true)
    expect(listed(repo)).toHaveLength(2)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
  })

  it('a tree whose card the bus has no record of is left untouched', () => {
    const tree = linkedCardTree(UNRECORDED)

    sweepPass()

    expect(existsSync(path.join(tree, 'README.md'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
  })

  it('a closed card\'s tree with a modified file has its work saved as a patch, is removed, and artifact.removed names the patch', () => {
    const tree = linkedCardTree(CLOSED)
    writeFileSync(path.join(tree, 'package.json'), '{"edited":true}\n')
    unlinkSync(path.join(tree, 'README.md'))
    startedIn(CLOSED, tree)
    closedCard(CLOSED)

    sweepPass()

    expect(existsSync(tree)).toBe(false)
    expect(readFileSync(savedTreePatch(CLOSED), 'utf8')).toContain('+{"edited":true}')
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([{ path: tree, by: CLOSER, patch: savedTreePatch(CLOSED) }])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
    expect(git(repo, ['branch', '--list', `feat/card-${CLOSED}`])).not.toBe('')
  })

  it('a closed card\'s half-deleted tree that also holds an untracked file has its work saved as a patch and is removed', () => {
    const tree = linkedCardTree(CLOSED)
    unlinkSync(path.join(tree, 'README.md'))
    writeFileSync(path.join(tree, 'notes.txt'), 'never committed\n')
    startedIn(CLOSED, tree)
    closedCard(CLOSED)

    sweepPass()

    expect(existsSync(tree)).toBe(false)
    expect(readFileSync(savedTreePatch(CLOSED), 'utf8')).toContain('+never committed')
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([{ path: tree, by: CLOSER, patch: savedTreePatch(CLOSED) }])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
  })

  it('a closed card\'s dirty tree with no bus directory to save into stays and gives board.alarm tree_left naming the unsaved work', () => {
    const tree = linkedCardTree(CLOSED)
    writeFileSync(path.join(tree, 'package.json'), '{"edited":true}\n')
    startedIn(CLOSED, tree)
    closedCard(CLOSED)

    recordEndedTrees(bench.db, CLOSER, bench.clock.now().toISOString(), new EndedCardTrees(bench.db, [root], gitWorktrees(repo), bench.clock.now).free())

    expect(readFileSync(path.join(tree, 'package.json'), 'utf8')).toBe('{"edited":true}\n')
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([{ reason: TREE_LEFT, path: tree, detail: `${UNSAVED}: no bus directory to save the tree into; ${DIRTY}:  M package.json` }])
  })

  it('the tree of a closed card that holds a live close lease is left untouched', () => {
    const tree = linkedCardTree(CLOSED)
    unlinkSync(path.join(tree, 'README.md'))
    startedIn(CLOSED, tree)
    closeLeased(CLOSED)
    closedCard(CLOSED)

    sweepPass()

    expect(existsSync(path.join(tree, 'package.json'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
  })

  it('an ended card\'s tree at the per-bus path and one at the old mc-<id> path are both swept', () => {
    const perBus = path.join(root, 'bus', 'worktrees')
    const current = linkedCardTree(CLOSED, perBus, String(CLOSED))
    const old = linkedCardTree(RUNNING, root)
    unlinkSync(path.join(current, 'README.md'))
    unlinkSync(path.join(old, 'README.md'))
    startedIn(CLOSED, current)
    startedIn(RUNNING, old)
    closedCard(CLOSED)
    closedCard(RUNNING)

    const ended = new EndedCardTrees(bench.db, [root, perBus], gitWorktrees(repo), bench.clock.now, [perBus]).free()
    recordEndedTrees(bench.db, CLOSER, bench.clock.now().toISOString(), ended)

    expect(existsSync(current)).toBe(false)
    expect(existsSync(old)).toBe(false)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toHaveLength(2)
  })

  it('a bare-id tree under a root that is not the per-bus one is left untouched though its card is closed', () => {
    const perBus = path.join(root, 'bus', 'worktrees')
    const tree = linkedCardTree(CLOSED, root, String(CLOSED))
    unlinkSync(path.join(tree, 'README.md'))
    startedIn(CLOSED, tree)
    closedCard(CLOSED)

    new EndedCardTrees(bench.db, [root, perBus], gitWorktrees(repo), bench.clock.now, [perBus]).free()

    expect(existsSync(path.join(tree, 'package.json'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
  })

  it('the close worker sweep removes a closed card\'s bare-id tree under the bus it serves and leaves a numeric directory beside the repo', () => {
    const bus = path.join(root, '.construct', 'a--one', 'bus.db')
    const perBusTree = linkedCardTree(CLOSED, path.join(busDirOf(bus), 'worktrees'), String(CLOSED))
    const besideRepo = linkedCardTree(CLOSED_BESIDE_REPO, path.dirname(repo), String(CLOSED_BESIDE_REPO))
    unlinkSync(path.join(perBusTree, 'README.md'))
    unlinkSync(path.join(besideRepo, 'README.md'))
    startedIn(CLOSED, perBusTree)
    startedIn(CLOSED_BESIDE_REPO, besideRepo)
    closedCard(CLOSED)
    closedCard(CLOSED_BESIDE_REPO)

    const ended = cardTreeSweep(bench.db, {}, bus, repo, gitWorktrees(repo), bench.clock.now).free()

    expect(ended).toEqual([{ cardId: CLOSED, path: perBusTree, left: null }])
    expect(existsSync(perBusTree)).toBe(false)
    expect(existsSync(path.join(besideRepo, 'package.json'))).toBe(true)
  })

  it('an mc-<id> tree outside the homes is left untouched though its card is closed', () => {
    const tree = linkedCardTree(CLOSED, path.join(root, 'elsewhere'))
    unlinkSync(path.join(tree, 'README.md'))
    startedIn(CLOSED, tree)
    closedCard(CLOSED)

    sweepPass()

    expect(existsSync(path.join(tree, 'package.json'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
  })

  it('an mc-<id> tree that is not the worktree card.started recorded is left untouched', () => {
    const tree = linkedCardTree(CLOSED)
    unlinkSync(path.join(tree, 'README.md'))
    startedIn(CLOSED, path.join(root, 'elsewhere', `mc-${CLOSED}`))
    closedCard(CLOSED)

    sweepPass()

    expect(existsSync(path.join(tree, 'package.json'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
  })
})

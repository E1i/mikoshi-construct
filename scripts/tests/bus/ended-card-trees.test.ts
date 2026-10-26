import type { WorktreeGit } from '../../nodes/close/ended-card-trees.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { busDirOf } from '../../core/bus-path.js'
import { RUNNING_CARD } from '../../core/card-automaton.js'
import { appendEvent } from '../../core/db.js'
import { ARTIFACT_REMOVED, BOARD_ALARM, CARD_ADMITTED, CARD_CLOSED, CARD_STARTED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { reduce } from '../../core/reducer.js'
import { cardTreeSweep, DIRTY, EndedCardTrees, gitWorktrees, recordEndedTrees } from '../../nodes/close/ended-card-trees.js'
import { TREE_LEFT } from '../../nodes/review/review-worker.js'
import { detectClose } from './close-detection.js'
import { cardVerified, eventsOf, mergeBench } from './merge-bench.js'

const CLOSED = 836
const CLOSED_BESIDE_REPO = 837
const RUNNING = 872
const UNRECORDED = 913
const CLOSER = 'worker:close:pass'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function listed(repo: string): string[] {
  return git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
}

let root: string
let repo: string
let bench: ReturnType<typeof mergeBench>

function cardTree(cardId: number, home = root, name = `mc-${cardId}`): string {
  const tree = path.join(home, name)
  git(repo, ['worktree', 'add', '-q', '-b', `feat/card-${cardId}`, tree])
  return realpathSync(tree)
}

function started(cardId: number, worktree: string): void {
  const ts = bench.clock.now().toISOString()
  appendEvent(bench.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { card: `#${cardId} part [implement/netwatch/S/cheap/auto] · depends — · blocks —`, lane: null, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
  appendEvent(bench.db, { ts, type: CARD_STARTED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${cardId}`, payload: { session: `s-${cardId}`, worktree, branch: `feat/card-${cardId}`, base: 'f'.repeat(40), pid: 1, pgid: 1 }, legacy: false })
  reduce(bench.db)
}

function closeLeased(cardId: number): void {
  const pr = cardId - 100
  bench.gitHub.open({ number: pr })
  bench.tick()
  cardVerified(bench.db, bench.clock.now().toISOString(), cardId, pr)
  bench.gitHub.close(pr, true)
  bench.tick()
  detectClose(bench.db, bench.clock.now)
  expect(leaseNext(bench.db, bench.clock.now().toISOString(), 'close', 'worker:close:other')).toMatchObject({ cardId })
}

function closed(cardId: number): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { verification: 'run' }, legacy: false })
}

function pass(trees: WorktreeGit = gitWorktrees(repo)): void {
  const ended = new EndedCardTrees(bench.db, [root], trees, bench.clock.now).free()
  recordEndedTrees(bench.db, CLOSER, bench.clock.now().toISOString(), ended)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ended-card-trees-')))
  repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(path.join(repo, 'README.md'), 'repo\n')
  writeFileSync(path.join(repo, 'package.json'), '{}\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  bench = mergeBench()
})

afterEach(() => {
  bench.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the close worker frees the trees of ended cards', () => {
  it('a closed card\'s half-deleted tree is removed by the pass without a new close, and artifact.removed carries path and by', () => {
    const tree = cardTree(CLOSED)
    unlinkSync(path.join(tree, 'README.md'))
    started(CLOSED, tree)
    closed(CLOSED)

    pass()

    expect(existsSync(tree)).toBe(false)
    expect(listed(repo)).toHaveLength(1)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([{ path: tree, by: CLOSER }])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
  })

  it('a half-deleted tree git refuses to remove is deleted as a directory and pruned', () => {
    const tree = cardTree(CLOSED)
    unlinkSync(path.join(tree, 'README.md'))
    started(CLOSED, tree)
    closed(CLOSED)
    const real = gitWorktrees(repo)

    pass({ ...real, remove: () => {
      throw Object.assign(new Error('git failed'), { stderr: 'fatal: Directory not empty' })
    } })

    expect(existsSync(tree)).toBe(false)
    expect(listed(repo)).toHaveLength(1)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([{ path: tree, by: CLOSER }])
  })

  it('the tree of a card in work is left untouched', () => {
    const tree = cardTree(RUNNING)
    started(RUNNING, tree)
    expect(bench.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(RUNNING)).toEqual({ state: RUNNING_CARD })

    pass()

    expect(existsSync(path.join(tree, 'README.md'))).toBe(true)
    expect(listed(repo)).toHaveLength(2)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
  })

  it('a tree whose card the bus has no record of is left untouched', () => {
    const tree = cardTree(UNRECORDED)

    pass()

    expect(existsSync(path.join(tree, 'README.md'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
  })

  it('a closed card\'s tree with a modified file stays and gives board.alarm tree_left with the reason dirty', () => {
    const tree = cardTree(CLOSED)
    writeFileSync(path.join(tree, 'package.json'), '{"edited":true}\n')
    unlinkSync(path.join(tree, 'README.md'))
    started(CLOSED, tree)
    closed(CLOSED)

    pass()

    expect(existsSync(path.join(tree, 'package.json'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([{ reason: TREE_LEFT, path: tree, detail: `${DIRTY}:  M package.json` }])
  })

  it('a closed card\'s half-deleted tree that also holds an untracked file stays and gives board.alarm tree_left with the reason dirty', () => {
    const tree = cardTree(CLOSED)
    unlinkSync(path.join(tree, 'README.md'))
    writeFileSync(path.join(tree, 'notes.txt'), 'never committed\n')
    started(CLOSED, tree)
    closed(CLOSED)

    pass()

    expect(existsSync(path.join(tree, 'notes.txt'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([{ reason: TREE_LEFT, path: tree, detail: `${DIRTY}: ?? notes.txt` }])
  })

  it('the tree of a closed card that holds a live close lease is left untouched', () => {
    const tree = cardTree(CLOSED)
    unlinkSync(path.join(tree, 'README.md'))
    started(CLOSED, tree)
    closeLeased(CLOSED)
    closed(CLOSED)

    pass()

    expect(existsSync(path.join(tree, 'package.json'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
  })

  it('an ended card\'s tree at the per-bus path and one at the old mc-<id> path are both swept', () => {
    const perBus = path.join(root, 'bus', 'worktrees')
    const current = cardTree(CLOSED, perBus, String(CLOSED))
    const old = cardTree(RUNNING, root)
    unlinkSync(path.join(current, 'README.md'))
    unlinkSync(path.join(old, 'README.md'))
    started(CLOSED, current)
    started(RUNNING, old)
    closed(CLOSED)
    closed(RUNNING)

    const ended = new EndedCardTrees(bench.db, [root, perBus], gitWorktrees(repo), bench.clock.now, [perBus]).free()
    recordEndedTrees(bench.db, CLOSER, bench.clock.now().toISOString(), ended)

    expect(existsSync(current)).toBe(false)
    expect(existsSync(old)).toBe(false)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toHaveLength(2)
  })

  it('a bare-id tree under a root that is not the per-bus one is left untouched though its card is closed', () => {
    const perBus = path.join(root, 'bus', 'worktrees')
    const tree = cardTree(CLOSED, root, String(CLOSED))
    unlinkSync(path.join(tree, 'README.md'))
    started(CLOSED, tree)
    closed(CLOSED)

    new EndedCardTrees(bench.db, [root, perBus], gitWorktrees(repo), bench.clock.now, [perBus]).free()

    expect(existsSync(path.join(tree, 'package.json'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
  })

  it('the close worker sweep removes a closed card\'s bare-id tree under the bus it serves and leaves a numeric directory beside the repo', () => {
    const bus = path.join(root, '.construct', 'a--one', 'bus.db')
    const perBusTree = cardTree(CLOSED, path.join(busDirOf(bus), 'worktrees'), String(CLOSED))
    const besideRepo = cardTree(CLOSED_BESIDE_REPO, path.dirname(repo), String(CLOSED_BESIDE_REPO))
    unlinkSync(path.join(perBusTree, 'README.md'))
    unlinkSync(path.join(besideRepo, 'README.md'))
    started(CLOSED, perBusTree)
    started(CLOSED_BESIDE_REPO, besideRepo)
    closed(CLOSED)
    closed(CLOSED_BESIDE_REPO)

    const ended = cardTreeSweep(bench.db, {}, bus, repo, gitWorktrees(repo), bench.clock.now).free()

    expect(ended).toEqual([{ cardId: CLOSED, path: perBusTree, left: null }])
    expect(existsSync(perBusTree)).toBe(false)
    expect(existsSync(path.join(besideRepo, 'package.json'))).toBe(true)
  })

  it('an mc-<id> tree outside the homes is left untouched though its card is closed', () => {
    const tree = cardTree(CLOSED, path.join(root, 'elsewhere'))
    unlinkSync(path.join(tree, 'README.md'))
    started(CLOSED, tree)
    closed(CLOSED)

    pass()

    expect(existsSync(path.join(tree, 'package.json'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
  })

  it('an mc-<id> tree that is not the worktree card.started recorded is left untouched', () => {
    const tree = cardTree(CLOSED)
    unlinkSync(path.join(tree, 'README.md'))
    started(CLOSED, path.join(root, 'elsewhere', `mc-${CLOSED}`))
    closed(CLOSED)

    pass()

    expect(existsSync(path.join(tree, 'package.json'))).toBe(true)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
  })
})

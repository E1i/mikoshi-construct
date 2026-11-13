import type { CardStart } from '../../nodes/launch/launch-executor.js'
import type { StarterPorts } from '../../nodes/launch/launch-starter.js'
import type { ProcessCwds } from '../../ports/client/contract.js'
import type { TreeDeps } from '../../ports/worktree.js'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { STOPPED_CARD } from '../../core/card-automaton.js'
import { appendEvent } from '../../core/db.js'
import { ARTIFACT_REMOVED, CARD_ADMITTED, CARD_CLOSED, CARD_STARTED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { reduce } from '../../core/reducer.js'
import { CloseExecutor, gitTreeRemover, treeMayBeReused } from '../../nodes/close/close-executor.js'
import { EndedCardTrees, gitWorktrees, recordEndedTrees } from '../../nodes/close/ended-card-trees.js'
import { ShiftCardStarter, staleTreeLine } from '../../nodes/launch/launch-starter.js'
import { GIT_TREE_TOOLS, ReviewTrees } from '../../nodes/review/reviewer.js'
import { gitCardTrees } from '../../ports/card-tree.js'
import { cutTree, FREE_TREE_CAPACITY, FREE_TREES, pnpmInstall } from '../../ports/worktree.js'
import { busProjections } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { detectClose } from './close-detection.js'
import { cardVerified, eventsOf, mergeBench } from './merge-bench.js'

const NO_SESSION = (): ProcessCwds => ({ kind: 'listed', cwds: [] })
const FIRST = 1701
const SECOND = 1702
const PR = 1601

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function listed(repo: string): string[] {
  return git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
}

let root: string
let repo: string
let home: string
let bench: ReturnType<typeof mergeBench>

function advanceMain(file: string): string {
  writeFileSync(path.join(repo, file), `${file}\n`)
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', file])
  git(repo, ['push', '-q', 'origin', 'main'])
  return git(repo, ['rev-parse', 'HEAD']).trim()
}

function deps(calls: string[][] = [], installs: string[] = []): TreeDeps {
  return {
    cwd: repo,
    git: (cwd, args) => {
      calls.push(args)
      return git(cwd, args)
    },
    install: cwd => installs.push(cwd),
    exists: existsSync,
    treeOf: id => path.join(home, id),
  }
}

function cut(id: number, calls: string[][] = [], installs: string[] = [], over: Partial<TreeDeps> = {}): { worktree: string, how: string } {
  const ready = cutTree({ ...deps(calls, installs), ...over }, String(id), `feat/card-${id}`)
  if ('refused' in ready)
    throw new Error(ready.refused)
  return ready
}

function workedOn(tree: string): string {
  writeFileSync(path.join(tree, 'card-work.txt'), 'work\n')
  git(tree, ['add', '.'])
  git(tree, ['commit', '-q', '-m', 'card work'])
  mkdirSync(path.join(tree, '.construct'), { recursive: true })
  writeFileSync(path.join(tree, '.construct', 'report.md'), 'the report of the card before\n')
  mkdirSync(path.join(tree, 'node_modules'), { recursive: true })
  writeFileSync(path.join(tree, 'node_modules', 'installed.txt'), 'kept\n')
  return git(tree, ['rev-parse', 'HEAD']).trim()
}

function freeNames(): string[] {
  const free = path.join(home, FREE_TREES)
  return existsSync(free) ? readdirSync(free) : []
}

function started(cardId: number, worktree: string): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:earlier-${cardId}`, payload: { session: `s-${cardId}`, worktree, branch: `feat/card-${cardId}`, base: 'f'.repeat(40), pid: 1, pgid: 1 }, legacy: false })
}

function closedEvent(cardId: number): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_CLOSED, actor: 'worker:close:earlier', cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { verification: 'run' }, legacy: false })
}

function sweep(cwds: () => ProcessCwds = NO_SESSION): void {
  const ended = new EndedCardTrees(bench.db, [home], gitWorktrees(repo), bench.clock.now, [home], cwds).free()
  recordEndedTrees(bench.db, 'worker:close:pass', bench.clock.now().toISOString(), ended)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'worktree-reuse-')))
  const origin = path.join(root, 'origin.git')
  repo = path.join(root, 'repo')
  home = path.join(root, 'bus', 'worktrees')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  git(repo, ['checkout', '-q', '-b', 'main'])
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.construct/\n')
  advanceMain('README.md')
  bench = mergeBench()
})

afterEach(() => {
  bench.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('a card takes a tree from the pool the close fills', () => {
  it('a card takes a free tree reset to its base and adds no new worktree', () => {
    const first = cut(FIRST)
    const before = workedOn(first.worktree)
    expect(gitTreeRemover(repo, FREE_TREE_CAPACITY).remove(first.worktree, true)).toMatchObject({ kept: false, parked: path.join(home, FREE_TREES, String(FIRST)) })
    expect(existsSync(first.worktree)).toBe(false)
    const base = advanceMain('newer.txt')
    const count = listed(repo).length
    const calls: string[][] = []
    const installs: string[] = []

    const second = cut(SECOND, calls, installs)

    expect(second.how).toContain('reused a free tree')
    expect(calls.some(args => args[0] === 'worktree' && args[1] === 'add')).toBe(false)
    expect(listed(repo)).toHaveLength(count)
    expect(freeNames()).toEqual([])
    expect(git(second.worktree, ['rev-parse', 'HEAD']).trim()).toBe(base)
    expect(git(second.worktree, ['branch', '--show-current']).trim()).toBe(`feat/card-${SECOND}`)
    expect(git(second.worktree, ['status', '--porcelain', '--ignored'])).toBe('!! node_modules/\n')
    expect(existsSync(path.join(second.worktree, 'card-work.txt'))).toBe(false)
    expect(existsSync(path.join(second.worktree, '.construct'))).toBe(false)
    expect(readFileSync(path.join(second.worktree, 'node_modules', 'installed.txt'), 'utf8')).toBe('kept\n')
    expect(git(second.worktree, ['branch', '--contains', before]).split('\n').some(line => line.includes(`feat/card-${SECOND}`))).toBe(false)
    expect(installs).toEqual([second.worktree])
  })

  it('with an empty pool a card cuts a tree as before', () => {
    const calls: string[][] = []
    const first = cut(FIRST, calls)
    expect(first.how).toContain('cut ')
    expect(calls.some(args => args[0] === 'worktree' && args[1] === 'add')).toBe(true)
  })

  it('the card tree home carries the marker that keeps Spotlight out', () => {
    cut(FIRST)
    expect(existsSync(path.join(home, '.metadata_never_index'))).toBe(true)
  })

  it('a free tree that will not settle on the new branch is dropped and the card cuts a new one', () => {
    const first = cut(FIRST)
    gitTreeRemover(repo, FREE_TREE_CAPACITY).remove(first.worktree, true)
    const real = deps()
    const second = cut(SECOND, [], [], { git: (cwd, args) => {
      if (args[0] === 'checkout' && args.includes('-B'))
        throw new Error('checkout refused')
      return real.git(cwd, args)
    } })
    expect(second.how).toContain('cut ')
    expect(freeNames()).toEqual([])
    expect(git(second.worktree, ['branch', '--show-current']).trim()).toBe(`feat/card-${SECOND}`)
  })

  it('a pool at capacity removes the tree instead of parking it', () => {
    const first = cut(FIRST)
    expect(gitTreeRemover(repo, 0).remove(first.worktree, true)).toEqual({ path: first.worktree, dirty: 0, kept: false })
    expect(existsSync(first.worktree)).toBe(false)
    expect(freeNames()).toEqual([])
  })

  it('an install links from the shared store', () => {
    const bin = path.join(root, 'bin')
    const said = path.join(root, 'pnpm-args')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh\necho "$@" > ${said}\n`)
    chmodSync(path.join(bin, 'pnpm'), 0o755)
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`)
    pnpmInstall(root, ['install', '--frozen-lockfile'])
    expect(readFileSync(said, 'utf8')).toBe('install --frozen-lockfile --config.packageImportMethod=hardlink\n')
  })
})

describe('what never enters the pool', () => {
  it('a dirty tree is kept, not parked, and the next card does not take it', () => {
    const first = cut(FIRST)
    writeFileSync(path.join(first.worktree, 'unsaved.txt'), 'left behind\n')
    expect(gitTreeRemover(repo, FREE_TREE_CAPACITY).remove(first.worktree, true)).toMatchObject({ kept: true, dirty: 1 })
    expect(freeNames()).toEqual([])
    expect(cut(SECOND).how).toContain('cut ')
    expect(existsSync(path.join(first.worktree, 'unsaved.txt'))).toBe(true)
  })

  it('a tree the close says may not be reused is removed, not parked', () => {
    const first = cut(FIRST)
    expect(gitTreeRemover(repo, FREE_TREE_CAPACITY).remove(first.worktree, false)).toEqual({ path: first.worktree, dirty: 0, kept: false })
    expect(freeNames()).toEqual([])
  })

  it('a stopped card and a tree with a live session may not be reused; an ended card with neither may', () => {
    const first = cut(FIRST)
    const card = { session: 's', worktree: first.worktree, branch: `feat/card-${FIRST}` }
    started(FIRST, first.worktree)
    expect(treeMayBeReused(bench.db, FIRST, card, NO_SESSION)).toBe(true)
    expect(treeMayBeReused(bench.db, FIRST, card, () => ({ kind: 'listed', cwds: [`${first.worktree}/scripts`] }))).toBe(false)
    expect(treeMayBeReused(bench.db, FIRST, card, () => ({ kind: 'unreadable', why: 'lsof refused' }))).toBe(false)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: FIRST, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${FIRST}`, payload: { card: `#${FIRST} part [implement/netwatch/S/cheap/auto] · depends — · blocks —`, lane: null, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
    reduce(bench.db, 'pending', busProjections())
    bench.db.prepare('UPDATE cards SET state = ? WHERE card_id = ?').run(STOPPED_CARD, FIRST)
    expect(treeMayBeReused(bench.db, FIRST, card, NO_SESSION)).toBe(false)
  })

  it('the sweep parks an ended card\'s clean tree and records where, and removes one with a live session', () => {
    const parked = cut(FIRST)
    const live = cut(SECOND)
    started(FIRST, parked.worktree)
    started(SECOND, live.worktree)
    closedEvent(FIRST)
    closedEvent(SECOND)

    sweep(() => ({ kind: 'listed', cwds: [live.worktree] }))

    expect(freeNames()).toEqual([String(FIRST)])
    expect(existsSync(parked.worktree)).toBe(false)
    expect(existsSync(live.worktree)).toBe(false)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([
      { path: parked.worktree, by: 'worker:close:pass', parked: path.join(home, FREE_TREES, String(FIRST)) },
      { path: live.worktree, by: 'worker:close:pass' },
    ])
  })
})

describe('the close that frees and the start that takes are one lifecycle', () => {
  it('a card closed through the executor leaves its tree in the pool, and the next card takes that tree', () => {
    const first = cut(FIRST)
    started(FIRST, first.worktree)
    bench.gitHub.open({ number: PR })
    bench.tick()
    cardVerified(bench.db, bench.clock.now().toISOString(), FIRST, PR)
    bench.gitHub.close(PR, true)
    bench.tick()
    detectClose(bench.db, bench.clock.now)
    const lease = leaseNext(bench.db, bench.clock.now().toISOString(), 'close', 'worker:close:lifecycle')!
    const executor = new CloseExecutor({ silentMs: SILENT_MS, db: bench.db, reported: () => 'run', clock: bench.clock.now, parking: path.join(root, 'parking'), trees: gitTreeRemover(repo, FREE_TREE_CAPACITY), cwds: NO_SESSION })

    expect(executor.close(lease)).toMatchObject({ kind: 'closed' })

    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([{ path: first.worktree, by: 'worker:close:lifecycle', dirty: 0, parked: path.join(home, FREE_TREES, String(FIRST)) }])
    const second = cut(SECOND)
    expect(second.how).toContain('reused a free tree')
    expect(freeNames()).toEqual([])
  })

  it('an answer that recreates a gone tree takes a free one on the card\'s branch', () => {
    const first = cut(FIRST)
    gitTreeRemover(repo, FREE_TREE_CAPACITY).remove(first.worktree, true)
    git(repo, ['branch', 'feat/answered', 'origin/main'])
    git(repo, ['push', '-q', 'origin', 'feat/answered'])
    const tree = path.join(home, String(SECOND))
    const installs: string[] = []

    gitCardTrees(repo, home, cwd => installs.push(cwd), () => ({ status: 200, body: {} }) as never).recreate(tree, 'feat/answered')

    expect(freeNames()).toEqual([])
    expect(git(tree, ['branch', '--show-current']).trim()).toBe('feat/answered')
    expect(installs).toEqual([tree])
  })

  it('a review tree goes back to the pool at release, survives the leftover pass and is taken by the next review at its head', () => {
    const dir = path.join(root, 'reviews')
    mkdirSync(dir)
    const tools = { ...GIT_TREE_TOOLS, prepare: () => {} }
    const trees = new ReviewTrees(repo, dir, tools)
    const headOne = git(repo, ['rev-parse', 'HEAD']).trim()
    const firstTree = path.join(dir, 'session-1')
    trees.add(firstTree, headOne)
    writeFileSync(path.join(firstTree, 'README.md'), 'mutated by the review\n')
    writeFileSync(path.join(firstTree, 'left.txt'), 'left\n')

    expect(trees.release(firstTree)).toBeNull()
    expect(existsSync(firstTree)).toBe(false)
    expect(trees.clearLeftovers()).toEqual([])
    expect(readdirSync(path.join(dir, FREE_TREES))).toEqual(['session-1'])

    const headTwo = advanceMain('second.txt')
    const count = listed(repo).length
    const secondTree = path.join(dir, 'session-2')
    trees.add(secondTree, headTwo)

    expect(listed(repo)).toHaveLength(count)
    expect(readdirSync(path.join(dir, FREE_TREES))).toEqual([])
    expect(git(secondTree, ['rev-parse', 'HEAD']).trim()).toBe(headTwo)
    expect(git(secondTree, ['status', '--porcelain'])).toBe('')
    expect(readFileSync(path.join(secondTree, 'README.md'), 'utf8')).toBe('README.md\n')
    expect(existsSync(path.join(secondTree, 'left.txt'))).toBe(false)
    expect(trees.holds(secondTree)).toBe(true)
  })
})

describe('a requeued card relaunched on the tree it holds', () => {
  function relaunch(tree: string, held: string): { start: CardStart, bodies: string[] } {
    const bodies: string[] = []
    const text = parkingFileText({ card: `#${FIRST} card-${FIRST} [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${FIRST}`, touches: ['src/**'], continue: 'auto', who: 'shift', body: 'Do the card.' })
    const ports: StarterPorts = {
      read: () => text,
      cut: () => {
        throw new Error('a card relaunched on its held tree is not cut again')
      },
      base: worktree => git(worktree, ['rev-parse', 'HEAD']).trim(),
      spawnDetached: () => 4242,
      pgidOf: pid => pid,
      kill: () => {},
      uuid: () => 's-relaunch',
      envOf: () => ({}),
      prompt: (task) => {
        bodies.push(task.body)
        return task.body
      },
      changedPaths: () => [],
      readReport: () => null,
      cardSessions: () => [],
      readTranscript: () => null,
      treeFile: () => null,
    }
    const starter = new ShiftCardStarter({ launchDir: path.join(root, 'launch'), claude: 'client-stub', treePr: 'tree-pr' }, ports)
    return { start: starter.start({ cardId: FIRST, lane: 'lane-a', continueIn: { worktree: tree, base: held } }), bodies }
  }

  it('a requeued card whose clean tree is behind main starts its session on fresh main', () => {
    const tree = cut(FIRST).worktree
    const held = git(tree, ['rev-parse', 'HEAD']).trim()
    const fresh = advanceMain('landed-on-main.txt')

    const { start, bodies } = relaunch(tree, held)

    expect(start).toMatchObject({ kind: 'started', card: { worktree: tree, base: fresh } })
    expect(git(tree, ['rev-parse', 'HEAD']).trim()).toBe(fresh)
    expect(existsSync(path.join(tree, 'landed-on-main.txt'))).toBe(true)
    expect(bodies[0]).not.toContain(staleTreeLine('').split(':')[0])
  })

  it('a requeued card whose tree carries its own commits keeps them, and its session is told the tree is not on fresh main', () => {
    const tree = cut(FIRST).worktree
    const held = git(tree, ['rev-parse', 'HEAD']).trim()
    const worked = workedOn(tree)
    advanceMain('landed-on-main.txt')

    const { start, bodies } = relaunch(tree, held)

    expect(start).toMatchObject({ kind: 'started', card: { worktree: tree, base: held } })
    expect(git(tree, ['rev-parse', 'HEAD']).trim()).toBe(worked)
    expect(bodies[0]).toContain(staleTreeLine(`${tree} carries 1 commit(s) over origin/main, so it was not brought to it`))
  })
})

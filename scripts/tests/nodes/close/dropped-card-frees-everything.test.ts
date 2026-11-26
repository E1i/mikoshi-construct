import type { ProcessCwds } from '../../../ports/client/contract.js'
import type { MergeBench } from '../../bus/merge-bench.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { busDirOf } from '../../../core/bus-path.js'
import { appendEvent, CLOSED_WAIT, openOwnerWait } from '../../../core/db.js'
import { ARTIFACT_REMOVED, BOARD_ALARM, CARD_ADMITTED, CARD_DROPPED, CARD_STARTED, PR_OBSERVED } from '../../../core/events.js'
import { TREE_LEFT } from '../../../core/node.js'
import { reduce } from '../../../core/reducer.js'
import { BRANCH_LEFT, cardTreeSweep, gitWorktrees, recordEndedTrees, TREE_PATCH, UNSAVED } from '../../../nodes/close/ended-card-trees.js'
import { busProjections } from '../../../supervisor/composition.js'
import { eventsOf, mergeBench } from '../../bus/merge-bench.js'

const CARD = 2055
const PR = 1755
const BRANCH = `feat/card-${CARD}`
const SWEEPER = 'worker:close:pass'
const NO_LIVE_SESSION: () => ProcessCwds = () => ({ kind: 'listed', cwds: [] })

let root: string
let repo: string
let bus: string
let bench: MergeBench

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function at(): string {
  return bench.clock.now().toISOString()
}

function settle(): void {
  reduce(bench.db, 'pending', busProjections())
}

function admitted(): void {
  appendEvent(bench.db, { ts: at(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: `#${CARD} part [implement/netwatch/S/cheap/auto] · depends — · blocks —`, lane: null, decision: 'auto', contour: 'cheap', depends: [] }, legacy: false })
}

function startedInATreeWithWork(): string {
  const tree = path.join(busDirOf(bus), 'worktrees', String(CARD))
  git(repo, ['worktree', 'add', '-q', '-b', BRANCH, tree])
  writeFileSync(path.join(tree, 'committed.txt'), 'a committed line\n')
  git(tree, ['add', 'committed.txt'])
  git(tree, ['commit', '-q', '-m', 'work on the card'])
  writeFileSync(path.join(tree, 'README.md'), 'an uncommitted line\n')
  admitted()
  appendEvent(bench.db, { ts: at(), type: CARD_STARTED, actor: 'worker:launch:earlier', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: `s-${CARD}`, worktree: realpathSync(tree), branch: BRANCH, base: 'f'.repeat(40), pid: 1, pgid: 1 }, legacy: false })
  settle()
  return realpathSync(tree)
}

function dropped(): void {
  appendEvent(bench.db, { ts: at(), type: CARD_DROPPED, actor: 'worker:intake:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:${CARD}`, payload: { lane: 'dropped', reason: 'superseded' }, legacy: false })
  settle()
}

function sweep(trees = gitWorktrees(repo), cwds = NO_LIVE_SESSION): void {
  const ended = cardTreeSweep(bench.db, {}, bus, repo, trees, bench.clock.now, cwds).free()
  recordEndedTrees(bench.db, SWEEPER, at(), ended)
}

function saved(name: string): string {
  return path.join(busDirOf(bus), 'probes', 'ended-trees', String(CARD), name)
}

function branchListed(): string {
  return git(repo, ['branch', '--list', BRANCH]).trim()
}

function waitRow(id: string): { state: string, answer: string | null } {
  return bench.db.prepare('SELECT state, answer FROM owner_waits WHERE id = ?').get(id) as { state: string, answer: string | null }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dropped-card-')))
  repo = path.join(root, 'repo')
  bus = path.join(root, '.construct', 'a--one', 'bus.db')
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

describe('card.dropped frees everything the card holds', () => {
  it('the dirty tree of a dropped card is saved as a patch and removed, and its branch is gone', () => {
    const tree = startedInATreeWithWork()
    dropped()

    sweep()

    expect(existsSync(tree)).toBe(false)
    expect(branchListed()).toBe('')
    const patch = readFileSync(saved(TREE_PATCH), 'utf8')
    expect(patch).toContain('+a committed line')
    expect(patch).toContain('+an uncommitted line')
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([{ path: tree, by: SWEEPER, patch: saved(TREE_PATCH) }])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
  })

  it('a card with the slug of the dropped card starts on the freed branch name', () => {
    startedInATreeWithWork()
    dropped()

    sweep()

    const again = path.join(root, 'again')
    git(repo, ['worktree', 'add', '-q', '-b', BRANCH, again])
    expect(git(again, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(BRANCH)
  })

  it('a wait opened on the PR of the dropped card with no card closes on the drop', () => {
    admitted()
    const head = 'a'.repeat(40)
    appendEvent(bench.db, { ts: at(), type: PR_OBSERVED, actor: 'netwatch', cardId: CARD, pr: PR, head, dedupeKey: `${PR_OBSERVED}:${PR}:${head}`, payload: { card_id: CARD, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, legacy: false })
    const wait = openOwnerWait(bench.db, at(), 'worker:review:r-1', { need: 'decision', text: `PR #${PR} asks`, pr: PR })
    settle()
    expect(waitRow(wait).state).not.toBe(CLOSED_WAIT)

    dropped()

    expect(waitRow(wait)).toEqual({ state: CLOSED_WAIT, answer: `card #${CARD} dropped` })
  })

  it('a card-bound wait of a dropped card closes on the drop', () => {
    admitted()
    const wait = openOwnerWait(bench.db, at(), 'worker:launch:l-1', { need: 'decision', text: `card #${CARD} asks`, command: `pnpm decide ${CARD}`, card: CARD })
    settle()

    dropped()

    expect(waitRow(wait)).toEqual({ state: CLOSED_WAIT, answer: `card #${CARD} dropped` })
  })

  it('a dropped card branch that cannot be deleted raises tree_left after its tree is saved and removed', () => {
    const tree = startedInATreeWithWork()
    dropped()
    const real = gitWorktrees(repo)

    sweep({ ...real, deleteBranch: () => {
      throw new Error('branch locked')
    } })

    expect(existsSync(tree)).toBe(false)
    expect(branchListed()).not.toBe('')
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([{ path: tree, by: SWEEPER, patch: saved(TREE_PATCH) }])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([{ reason: TREE_LEFT, path: tree, detail: `${BRANCH_LEFT} ${BRANCH}: branch locked` }])
  })

  it('a dropped card tree that a live session works in stays with its branch', () => {
    const tree = startedInATreeWithWork()
    dropped()

    sweep(gitWorktrees(repo), () => ({ kind: 'listed', cwds: [path.join(tree, 'scripts')] }))

    expect(readFileSync(path.join(tree, 'README.md'), 'utf8')).toBe('an uncommitted line\n')
    expect(branchListed()).not.toBe('')
    expect(existsSync(saved(TREE_PATCH))).toBe(false)
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([])
  })

  it('a dropped card tree whose patch cannot be written stays with its branch and raises tree_left', () => {
    const tree = startedInATreeWithWork()
    dropped()
    const real = gitWorktrees(repo)

    sweep({ ...real, save: () => {
      throw new Error('disk full')
    } })

    expect(readFileSync(path.join(tree, 'README.md'), 'utf8')).toBe('an uncommitted line\n')
    expect(branchListed()).not.toBe('')
    expect(eventsOf(bench.db, ARTIFACT_REMOVED)).toEqual([])
    expect(eventsOf(bench.db, BOARD_ALARM)).toEqual([{ reason: TREE_LEFT, path: tree, detail: `${UNSAVED}: disk full; dirty:  M README.md` }])
  })
})

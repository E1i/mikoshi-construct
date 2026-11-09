import type { Lease } from '../../core/lease.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STOPPED, OWNER_WAIT_OPENED, UPDATE_DONE } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { answerCandidates, updateCandidates } from '../../core/queue.js'
import { UpdateExecutor } from '../../nodes/update/update-executor.js'
import { mainMergeInCardTree } from '../../ports/main-merge.js'
import { eventsOf, liveBench, taskState } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const OWN = 'scripts/own.ts'
const CHANGESET = '.changeset/shared.md'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(tree: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
  writeFileSync(path.join(tree, file), text)
}

function commitAll(tree: string, message: string): string {
  git(tree, ['add', '-A'])
  git(tree, ['commit', '-q', '-m', message])
  return git(tree, ['rev-parse', 'HEAD'])
}

interface Conflict {
  tree: string
  origin: string
  branch: string
  head: string
}

function conflictOn(file: string, cardId: number): Conflict {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-update-conflict-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const tree = path.join(root, 'tree')
  const branch = `feat/card-${cardId}`
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' })
  git(seed, ['checkout', '-q', '-b', 'main'])
  write(seed, OWN, 'base\n')
  write(seed, CHANGESET, 'base\n')
  commitAll(seed, 'base')
  git(seed, ['push', '-q', 'origin', 'main'])
  execFileSync('git', ['clone', '-q', '-b', 'main', origin, tree], { stdio: 'ignore' })
  git(tree, ['checkout', '-q', '-b', branch])
  write(tree, file, 'card version\n')
  const head = commitAll(tree, 'card work')
  git(tree, ['push', '-q', 'origin', branch])
  write(seed, file, 'main version\n')
  commitAll(seed, 'main moves')
  git(seed, ['push', '-q', 'origin', 'main'])
  return { tree, origin, branch, head }
}

function admitted(bench: MergeBench, cardId: number, branch: string): void {
  const text = `card: #${cardId} task-${cardId} [implement/construct/S/cheap/owner] · depends — · blocks —\nbranch: ${branch}\ntouches: ${OWN}\nwho: shift\n\ndo ${cardId}\n`
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { text, textSha: textSha(text), lane: null, decision: 'owner', contour: 'cheap', depends: [] }, legacy: false })
}

function conflictBench(file: string, pr: number) {
  const cardId = pr + 100
  const conflict = conflictOn(file, cardId)
  const bench = liveBench()
  admitted(bench, cardId, conflict.branch)
  bench.gitHub.open({ number: pr, head: conflict.head, mergeable_state: 'dirty' })
  bench.tick()
  detectUpdate(bench)
  const executor = new UpdateExecutor({ db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {}, mergeMain: mainMergeInCardTree(git, () => conflict.tree) })
  const lease = (): Lease | null => leaseNext(bench.db, bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')
  return { bench, conflict, cardId, lease, executor }
}

describe('the update node on a pull request in conflict with main', () => {
  it('a conflicting card pull request is routed to the update node and to no answer', () => {
    const { bench, cardId } = conflictBench(CHANGESET, 1092)
    expect(updateCandidates(bench.db, bench.clock.now().toISOString()).map(task => task.cardId)).toEqual([cardId])
    expect(answerCandidates(bench.db, bench.clock.now().toISOString())).toEqual([])
    bench.close()
  })

  it('a PR conflicting with main on a path outside its touches gets a merge commit with main version and stands in CI again', () => {
    const { bench, conflict, cardId, lease, executor } = conflictBench(CHANGESET, 1093)
    const leased = lease()!
    expect(leased).toMatchObject({ queue: 'update', cardId, pr: 1093, head: conflict.head })

    const outcome = executor.update(leased)

    const merged = git(conflict.tree, ['rev-parse', 'HEAD'])
    expect(outcome).toMatchObject({ kind: 'updated', from: conflict.head, to: merged, carry: { carried: null, clean: false } })
    expect(git(conflict.tree, ['rev-list', '--parents', '-n', '1', merged]).split(' ')).toEqual([merged, conflict.head, git(conflict.tree, ['rev-parse', 'origin/main'])])
    expect(readFileSync(path.join(conflict.tree, CHANGESET), 'utf8')).toBe('main version\n')
    expect(git(conflict.origin, ['rev-parse', `refs/heads/${conflict.branch}`])).toBe(merged)
    expect(eventsOf(bench.db, UPDATE_DONE)).toMatchObject([{ from: conflict.head, to: merged, tookMain: [CHANGESET], clean: false }])
    expect(eventsOf(bench.db, CARD_STOPPED)).toEqual([])
    expect(taskState(bench.db, leased.taskKey).state).toBe('completed')
    bench.close()
  })

  it('a conflict inside the card touches stops the card with question.owner', () => {
    const { bench, conflict, cardId, lease, executor } = conflictBench(OWN, 1094)
    const leased = lease()!

    const outcome = executor.update(leased)

    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'question.owner', detail: expect.stringContaining(OWN) })
    expect(eventsOf(bench.db, CARD_STOPPED)).toMatchObject([{ reason: 'question.owner', detail: expect.stringContaining(OWN) }])
    expect(eventsOf(bench.db, OWNER_WAIT_OPENED)).toMatchObject([{ need: 'decision', card: cardId, pr: 1094 }])
    expect(eventsOf(bench.db, UPDATE_DONE)).toEqual([])
    expect(git(conflict.tree, ['rev-parse', 'HEAD'])).toBe(conflict.head)
    expect(git(conflict.tree, ['status', '--porcelain'])).toBe('')
    expect(git(conflict.origin, ['rev-parse', `refs/heads/${conflict.branch}`])).toBe(conflict.head)
    expect(taskState(bench.db, leased.taskKey).state).toBe('completed')
    bench.close()
  })

  it('a card tree that does not stand at the leased head is refused, nothing is pushed, and the conflict goes to the answer node', () => {
    const { bench, conflict, lease, executor } = conflictBench(CHANGESET, 1095)
    write(conflict.tree, 'stray.txt', 'stray\n')
    commitAll(conflict.tree, 'stray')

    const leased = lease()!
    expect(executor.update(leased)).toMatchObject({ kind: 'denied', denial: { reason: 'merge_refused', detail: expect.stringContaining(`not at the head ${conflict.head}`) } })
    expect(git(conflict.origin, ['rev-parse', `refs/heads/${conflict.branch}`])).toBe(conflict.head)
    expect(taskState(bench.db, leased.taskKey).state).toBe('withdrawn')
    expect(answerCandidates(bench.db, bench.clock.now().toISOString())).toMatchObject([{ queue: 'answer', cardId: 1195, pr: 1095, head: conflict.head }])
    bench.close()
  })

  it('a merge whose push fails leaves the tree back at the leased head and nothing pushed', () => {
    const { bench, conflict, lease, executor } = conflictBench(CHANGESET, 1096)
    const elsewhere = path.join(path.dirname(conflict.origin), 'elsewhere')
    execFileSync('git', ['clone', '-q', '-b', conflict.branch, conflict.origin, elsewhere], { stdio: 'ignore' })
    write(elsewhere, 'moved.txt', 'moved\n')
    const moved = commitAll(elsewhere, 'the card branch moves')
    git(elsewhere, ['push', '-q', 'origin', conflict.branch])

    const leased = lease()!
    expect(executor.update(leased)).toMatchObject({ kind: 'denied', denial: { reason: 'merge_refused', detail: expect.stringContaining(`the tree went back to ${conflict.head}`) } })
    expect(git(conflict.tree, ['rev-parse', 'HEAD'])).toBe(conflict.head)
    expect(git(conflict.tree, ['status', '--porcelain'])).toBe('')
    expect(git(conflict.origin, ['rev-parse', `refs/heads/${conflict.branch}`])).toBe(moved)
    expect(eventsOf(bench.db, UPDATE_DONE)).toEqual([])
    expect(taskState(bench.db, leased.taskKey).state).toBe('withdrawn')
    bench.close()
  })
})

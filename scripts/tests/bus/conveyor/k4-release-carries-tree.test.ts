import type { Lease } from '../../../core/lease.js'
import type { ChildRun } from '../../../core/node.js'
import type { Answerer } from '../../../nodes/answer/answerer.js'
import type { TreePushPolicy } from '../../../nodes/answer/duties/tree.js'
import type { CardTreeTools } from '../../../ports/card-tree.js'
import type { MergeBench } from '../merge-bench.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CHILD_ENDED, REVIEW_RECORDED, SIGNAL_SENT, TASK_FAILED, TASK_RELEASED } from '../../../core/events.js'
import { leaseNext, RESTART_CUT } from '../../../core/lease.js'
import { ChildLog, INSTANCE_VARIABLE } from '../../../core/node.js'
import { QUEUED, queueTask } from '../../../core/queue.js'
import { AnswerExecutor, CARRIED_TREE } from '../../../nodes/answer/answer-executor.js'
import { carriedTreeOf } from '../../../nodes/answer/answer-source.js'
import { spawnClient } from '../../../nodes/answer/duties/client.js'
import { BusRead } from '../../../ports/bus-read.js'
import { OsProcessTable } from '../../../ports/process-table.js'
import { cardTransitions } from '../../../supervisor/composition.js'
import { SILENT_MS } from '../../../supervisor/liveness-sites.js'
import { tableIdentity } from '../../../supervisor/recorded-worker.js'
import { mergeBench } from '../merge-bench.js'

const CARD = 1910
const PR = CARD - 100
const BRANCH = `feat/card-${CARD}`
const ANSWER_WORKER = 'worker:answer:k4'
const UPDATE_WORKER = 'worker:update:k4'
const MERGED_LINE = 'merged'
const SESSION_LIFE_SECONDS = 60

const roots: string[] = []
const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function identified(tree: string): void {
  git(tree, ['config', 'user.name', 'bus'])
  git(tree, ['config', 'user.email', 'bus@example.invalid'])
  git(tree, ['config', 'commit.gpgsign', 'false'])
}

function committed(tree: string, file: string, message: string): string {
  mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
  writeFileSync(path.join(tree, file), `${message}\n`)
  git(tree, ['add', '-A'])
  git(tree, ['commit', '-q', '-m', message])
  return git(tree, ['rev-parse', 'HEAD'])
}

interface Repository {
  trees: string
  origin: string
  seed: string
  tree: string
  head: string
}

function cardTreeBehindMain(): Repository {
  const trees = mkdtempSync(path.join(tmpdir(), 'k4-release-carries-tree-'))
  roots.push(trees)
  const origin = path.join(trees, 'origin.git')
  const seed = path.join(trees, 'seed')
  git(trees, ['init', '-q', '--bare', origin])
  git(trees, ['init', '-q', seed])
  identified(seed)
  committed(seed, 'README.md', 'base')
  git(seed, ['push', '-q', origin, 'HEAD:refs/heads/main'])
  const tree = path.join(trees, `mc-${CARD}`)
  git(trees, ['clone', '-q', origin, tree])
  identified(tree)
  git(tree, ['checkout', '-q', '-b', BRANCH])
  const head = committed(tree, 'scripts/card.ts', 'the card change')
  git(tree, ['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`])
  committed(seed, 'scripts/fix-on-main.ts', 'a fix merged to main')
  git(seed, ['push', '-q', origin, 'HEAD:refs/heads/main'])
  return { trees, origin, seed, tree, head }
}

function branchOnTheFakeGitHub(repo: Repository): string {
  return git(repo.origin, ['rev-parse', `refs/heads/${BRANCH}`])
}

function cardUnderReview(made: MergeBench, repo: Repository): void {
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}` }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: repo.tree, branch: BRANCH, base: repo.head }, legacy: false })
  made.gitHub.open({ number: PR, head: repo.head, review: 'failure', mergeable_state: 'behind' })
  appendEvent(made.db, { ts, type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: CARD, pr: PR, head: repo.head, dedupeKey: `${REVIEW_RECORDED}:${PR}`, payload: { head: repo.head, verdict: 'changes', reviewer_session: 'reviewer-1', findings: ['name the reader'] }, legacy: false })
  made.tick()
  queueTask(made.db, made.clock.now().toISOString(), { queue: 'update', cardId: CARD, pr: PR, head: repo.head })
}

interface Killed {
  pid: number | null
}

function sessionKilledFromOutside(made: MergeBench, repo: Repository, script: string, killed: Killed): Answerer {
  const log = new ChildLog(write => write(made.db), tableIdentity(new OsProcessTable()), () => new Date(), { [INSTANCE_VARIABLE]: 'k4' })
  return async (request) => {
    const run: ChildRun = { actor: request.lease.actor, taskKey: request.lease.taskKey, kind: 'answer', tree: repo.tree }
    const code = await log.around(run, async started => spawnClient({
      cwd: repo.tree,
      command: 'sh',
      argv: ['-c', `${script} && echo ${MERGED_LINE} && exec sleep ${SESSION_LIFE_SECONDS}`],
      stdoutPath: path.join(repo.trees, 'session.out'),
      stderrPath: path.join(repo.trees, 'session.err'),
      env: process.env,
      started: (pid) => {
        killed.pid = pid
        return started(pid)
      },
      onLine: (line) => {
        if (line === MERGED_LINE && killed.pid !== null)
          process.kill(killed.pid, 'SIGKILL')
      },
    }))
    throw new Error(`the answer session exited ${code}`)
  }
}

function executorOn(made: MergeBench, repo: Repository, answerer: Answerer, pushPolicy: TreePushPolicy | undefined = 'bus'): AnswerExecutor {
  const cardTrees: CardTreeTools = { home: repo.trees, exists: existsSync, branchOf: () => BRANCH, recreate: () => {}, bringTo: () => {} }
  return new AnswerExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, liveSession: () => null, prepare: () => {}, mergeMain: () => () => ({ kind: 'refused', why: 'the tree holds the answer session' }), ...(pushPolicy === undefined ? {} : { pushPolicy: () => pushPolicy }) })
}

function answerLease(made: MergeBench): Lease {
  return leaseNext(made.db, made.clock.now().toISOString(), 'answer', ANSWER_WORKER)!
}

function updateLease(made: MergeBench): Lease | null {
  return leaseNext(made.db, made.clock.now().toISOString(), 'update', UPDATE_WORKER)
}

describe('k4 [needs ps]: scenario 04, the release carries the tree and the returned answer owns it', () => {
  it('scenario 04: a session SIGKILLed after its local main merge returns the merge with the task; the next answer pushes it and the update after it succeeds', async () => {
    const made = mergeBench()
    benches.push(made)
    const repo = cardTreeBehindMain()
    cardUnderReview(made, repo)
    const lease = answerLease(made)
    expect(lease).toMatchObject({ cardId: CARD, pr: PR, head: repo.head })
    const killed: Killed = { pid: null }

    const failed = await executorOn(made, repo, sessionKilledFromOutside(made, repo, 'git fetch -q origin && git merge -q --no-edit origin/main', killed)).answer(lease)

    const merge = git(repo.tree, ['rev-parse', 'HEAD'])
    expect(merge).not.toBe(repo.head)
    expect(git(repo.tree, ['rev-list', '--parents', '-n', '1', merge]).split(' ')).toHaveLength(3)
    const read = new BusRead(made.db)
    expect(read.slice(CHILD_ENDED, ['pid', 'signal', 'task_key']).map(each => each.fields)).toEqual([{ pid: killed.pid, signal: 'SIGKILL', task_key: lease.taskKey }])
    expect(read.slice(SIGNAL_SENT, ['pid'])).toEqual([])
    expect(failed).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed' }, next: QUEUED })
    const [carrier] = read.slice(TASK_FAILED, ['reason', 'tree'])
    expect(carrier?.fields).toEqual({ reason: 'answer_failed', tree: { path: repo.tree, head: merge, localCommits: [merge], dirty: false } })
    expect(read.slice(TASK_RELEASED, ['reason']).map(each => each.fields)).not.toContainEqual({ reason: RESTART_CUT })
    expect(branchOnTheFakeGitHub(repo)).toBe(repo.head)
    expect(updateLease(made), 'the update waits while the tree is carried').toBeNull()

    const next = answerLease(made)
    expect(next).toMatchObject({ taskKey: lease.taskKey, cardId: CARD })
    const owned = await executorOn(made, repo, async () => {
      throw new Error('the returned answer owns the tree and starts no session')
    }).answer(next)

    expect(owned).toMatchObject({ kind: 'answered', head: merge })
    expect(branchOnTheFakeGitHub(repo)).toBe(merge)
    expect(git(repo.tree, ['rev-parse', 'HEAD'])).toBe(branchOnTheFakeGitHub(repo))
    expect(read.slice(CARD_ANSWERED, ['source', 'from', 'to']).map(each => each.fields)).toEqual([{ source: CARRIED_TREE, from: repo.head, to: merge }])
    expect(carriedTreeOf(made.db, CARD)).toBeNull()

    committed(repo.seed, 'scripts/second-fix.ts', 'a second fix merged to main')
    git(repo.seed, ['push', '-q', repo.origin, 'HEAD:refs/heads/main'])
    made.gitHub.open({ number: PR, head: merge, mergeable_state: 'behind' })
    made.tick()
    queueTask(made.db, made.clock.now().toISOString(), { queue: 'update', cardId: CARD, pr: PR, head: merge })
    expect(updateLease(made), 'the update after the answer is leased').toMatchObject({ cardId: CARD, pr: PR, head: merge })
    git(repo.tree, ['fetch', '-q', 'origin'])
    git(repo.tree, ['merge', '-q', '--no-edit', 'origin/main'])
    git(repo.tree, ['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`])
    expect(branchOnTheFakeGitHub(repo)).toBe(git(repo.tree, ['rev-parse', 'HEAD']))
  }, 60_000)

  it('scenario 04: a session SIGKILLed with uncommitted work returns a dirty tree; the next answer resets it to the pull request head', async () => {
    const made = mergeBench()
    benches.push(made)
    const repo = cardTreeBehindMain()
    cardUnderReview(made, repo)
    const lease = answerLease(made)
    const killed: Killed = { pid: null }

    await executorOn(made, repo, sessionKilledFromOutside(made, repo, 'echo half-done > scripts/card.ts', killed)).answer(lease)

    const read = new BusRead(made.db)
    expect(read.slice(TASK_FAILED, ['tree']).map(each => each.fields)).toEqual([{ tree: { path: repo.tree, head: repo.head, localCommits: [], dirty: true } }])
    expect(updateLease(made)).toBeNull()

    const sessions: string[] = []
    await executorOn(made, repo, async (request) => {
      sessions.push(git(request.card.worktree, ['status', '--porcelain']))
      return { session: 'card-session-1', resumed: true, before: repo.head, after: repo.head, owner: null }
    }).answer(answerLease(made))

    expect(sessions).toEqual([''])
    expect(git(repo.tree, ['rev-parse', 'HEAD'])).toBe(repo.head)
    expect(branchOnTheFakeGitHub(repo)).toBe(git(repo.tree, ['rev-parse', 'HEAD']))
    expect(carriedTreeOf(made.db, CARD)).toBeNull()
    expect(updateLease(made)).toMatchObject({ cardId: CARD, head: repo.head })
  }, 60_000)
})

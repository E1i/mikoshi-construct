import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/answer-executor.js'
import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { machineBusPath } from '../../core/bus-path.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, POLICY_DENIED, PR_OBSERVED, PR_OPENED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { reportPath, treeReportPath } from '../../core/places.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { treePublishing } from '../../nodes/answer/answer-worker.js'
import { publishedTreePr } from '../../nodes/launch/launch-root.js'
import { launchDirOf, treePrOfThisBuild } from '../../ports/tree-publish.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1495
const OPENED_PR = 9495
const SESSION = 'answer-session-1'

const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-answer-publish-'))
  roots.push(root)
  return root
}

interface Bench {
  made: MergeBench
  worktree: string
  lease: () => Lease
  answer: (publish: () => void, committed?: boolean, dirty?: boolean) => Promise<AnswerOutcome>
}

function stoppedCardWithoutAPullRequest(): Bench {
  const made = mergeBench()
  benches.push(made)
  const trees = tempDir()
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: `a question on card #${CARD}` }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, ts, { queue: 'answer', cardId: CARD, stop })
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const answerer: Answerer = async () => ({ session: SESSION, resumed: true, before: sha('a'), after: sha('a'), owner: null })
  const lease = (): Lease => leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!
  const answer = async (publish: () => void, committed = true, dirty = false): Promise<AnswerOutcome> => {
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => dirty, liveSession: () => null, publishing: { committed: () => committed, publish } })
    return executor.answer(lease())
  }
  return { made, worktree, lease, answer }
}

function treePrOpens(made: MergeBench, pr: number): () => void {
  return () => {
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:1', cardId: CARD, pr, head: null, dedupeKey: `${PR_OPENED}:${CARD}:${pr}`, payload: { pr }, legacy: false })
  }
}

function cardRow(made: MergeBench): { state: string, pr: number | null } {
  return made.db.prepare('SELECT state, pr FROM cards WHERE card_id = ?').get(CARD) as { state: string, pr: number | null }
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function repositoryWithACommitAhead(): string {
  const repo = tempDir()
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'bus@example.invalid')
  git(repo, 'config', 'user.name', 'bus')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return repo
}

describe('an answer that leaves a clean tree on a card with no pull request', () => {
  it('committed tree without a PR is published: tree-pr runs once and the answer is recorded as published', async () => {
    const bench = stoppedCardWithoutAPullRequest()
    const publish = vi.fn(treePrOpens(bench.made, OPENED_PR))

    const outcome = await bench.answer(publish)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ kind: 'published', session: SESSION, pr: OPENED_PR })
    expect(eventsOf(bench.made.db, CARD_ANSWERED)).toEqual([expect.objectContaining({ published: true, pr: OPENED_PR, session: SESSION })])
    expect(eventsOf(bench.made.db, POLICY_DENIED)).toEqual([])
  })

  it('committed tree without a PR is published: the card ends in review, linked to the pull request tree-pr opened on a stopped card', async () => {
    const bench = stoppedCardWithoutAPullRequest()

    await bench.answer(treePrOpens(bench.made, OPENED_PR))
    bench.made.tick()

    expect(cardRow(bench.made)).toEqual({ state: 'in_review', pr: OPENED_PR })
  })

  it('no publish when a PR exists or nothing is ahead: an open pull request of the card keeps the publisher out', async () => {
    const bench = stoppedCardWithoutAPullRequest()
    appendEvent(bench.made.db, { ts: bench.made.clock.now().toISOString(), type: PR_OBSERVED, actor: 'worker:netwatch:1', cardId: CARD, pr: OPENED_PR, head: sha('a'), dedupeKey: `${PR_OBSERVED}:${OPENED_PR}`, payload: { base: 'main', head: sha('a'), mergeable: 'clean', ci: 'pending', verdict_on_head: null, auto_merge: false, draft: false, branch: `feat/card-${CARD}` }, legacy: false })
    bench.made.tick()
    const publish = vi.fn()

    const outcome = await bench.answer(publish)

    expect(publish).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'left_nothing' } })
  })

  it('no publish when a PR exists or nothing is ahead: a tree with no commit ahead keeps the publisher out', async () => {
    const bench = stoppedCardWithoutAPullRequest()
    const publish = vi.fn()

    const outcome = await bench.answer(publish, false)

    expect(publish).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'left_nothing' } })
  })

  it('a tree with uncommitted changes stays answer_failed and is not published', async () => {
    const bench = stoppedCardWithoutAPullRequest()
    const publish = vi.fn()

    const outcome = await bench.answer(publish, true, true)

    expect(publish).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed' } })
  })

  it('failed publish keeps left_nothing and counts one empty answer', async () => {
    const bench = stoppedCardWithoutAPullRequest()
    const publish = vi.fn()

    const outcome = await bench.answer(publish)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'left_nothing', detail: expect.stringContaining('empty answer 1 of') as unknown }, next: 'queued' })
    expect(eventsOf(bench.made.db, CARD_ANSWERED)).toEqual([])
    expect(bench.made.db.prepare(`SELECT state, failures FROM tasks WHERE queue = 'answer' AND card_id = ?`).get(CARD)).toEqual({ state: 'queued', failures: 1 })
  })
})

describe('the tree publishing the answer worker wires', () => {
  function recordingTreePr(root: string): { command: string, calls: string } {
    const calls = path.join(root, 'calls')
    const script = path.join(root, 'tree-pr.sh')
    writeFileSync(script, `#!/bin/sh\nprintf '%s %s %s %s\\n' "$1" "$2" "$3" "$(cat "$2/.construct/report.md")" >> ${calls}\n`)
    chmodSync(script, 0o755)
    return { command: script, calls }
  }

  it('runs tree-pr with the card, its tree and the saved report, restored into the tree for tree-pr to collect', () => {
    const root = tempDir()
    const worktree = path.join(root, 'tree')
    const launchDir = path.join(root, 'launch')
    mkdirSync(worktree)
    mkdirSync(launchDir)
    const saved = reportPath(launchDir, String(CARD))
    writeFileSync(saved, 'the saved report')
    const treePr = recordingTreePr(root)

    treePublishing(treePr.command, launchDir, process.env).publish({ session: SESSION, worktree, branch: 'feat/x' }, CARD)

    expect(readFileSync(treePr.calls, 'utf8')).toBe(`${CARD} ${worktree} ${saved} the saved report\n`)
  })

  it('a report the answer session wrote in the tree is not overwritten by the saved one', () => {
    const root = tempDir()
    const worktree = path.join(root, 'tree')
    const launchDir = path.join(root, 'launch')
    mkdirSync(path.dirname(treeReportPath(worktree)), { recursive: true })
    mkdirSync(launchDir)
    writeFileSync(treeReportPath(worktree), 'the answer report')
    writeFileSync(reportPath(launchDir, String(CARD)), 'the saved report')
    const treePr = recordingTreePr(root)

    treePublishing(treePr.command, launchDir, process.env).publish({ session: SESSION, worktree, branch: 'feat/x' }, CARD)

    expect(readFileSync(treePr.calls, 'utf8')).toContain('the answer report')
  })

  it('counts commits ahead of origin/main, not of the base the session started on', () => {
    const repo = repositoryWithACommitAhead()
    const { committed } = treePublishing('true', tempDir(), process.env)
    const card = { session: SESSION, worktree: repo, branch: 'main' }

    expect(committed(card)).toBe(false)
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'ahead')
    expect(committed(card)).toBe(true)
  })

  it('a tree whose commits cannot be counted is not published', () => {
    const { committed } = treePublishing('true', tempDir(), process.env)

    expect(committed({ session: SESSION, worktree: path.join(tempDir(), 'not-a-repository'), branch: 'main' })).toBe(false)
  })

  it('a tree-pr that fails leaves the worker standing and names the card in its log', () => {
    const root = tempDir()
    const worktree = path.join(root, 'tree')
    mkdirSync(worktree)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => treePublishing('false', root, process.env).publish({ session: SESSION, worktree, branch: 'feat/x' }, CARD)).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`card #${CARD}: tree-pr failed`))
    log.mockRestore()
  })
})

describe('the tree-publish port both workers import', () => {
  it('from a source checkout runs the launch node\'s command, a path with a quote in it included', () => {
    const repo = '/work/o\'brien/repo'

    expect(treePrOfThisBuild(repo, 'file:///work/scripts/ports/tree-publish.ts')).toBe(publishedTreePr(repo, null))
  })

  it('from an installed package runs the launch node\'s built entry', () => {
    const installed = '/opt/pkg/'

    expect(treePrOfThisBuild('/unused', `file://${installed}dist/scripts/ports/tree-publish.js`)).toBe(publishedTreePr('/unused', installed))
  })

  it('finds the saved reports beside the shift on the machine bus and beside the bus elsewhere', () => {
    expect(launchDirOf('/home/me', machineBusPath('/home/me'))).toBe(path.join(path.dirname(machineBusPath('/home/me')), 'shift', 'launch'))
    expect(launchDirOf('/home/me', '/elsewhere/bus/bus.db')).toBe('/elsewhere/bus/bus/launch')
  })
})

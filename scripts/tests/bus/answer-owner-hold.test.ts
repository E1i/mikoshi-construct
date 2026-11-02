import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/answer-executor.js'
import type { AnswerRun } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_HELD, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED, POLICY_DENIED, QUESTION_OWNER } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer, liveSessionIn, pendingPathsOf } from '../../nodes/answer/answerer.js'
import { requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 905
const PR_OF_THE_CARD = CARD - 100
const TOUCHED = 'scripts/a.ts'
const ANOTHER_CARDS_CHANGESET = '.changeset/p7creates.md'

const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Card {
  made: MergeBench
  trees: string
  lease: () => Lease
}

function stoppedCard(admittedBody = true, widen: string[] = []): Card {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-hold-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  if (admittedBody)
    appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: `a question on card #${CARD}`, ...(widen.length === 0 ? {} : { widen }) }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, ts, { queue: 'answer', cardId: CARD, stop })
  return { made, trees, lease: () => leaseNext(made.db, ts, 'answer', 'worker:answer:worker-1')! }
}

function sessionEnded(made: MergeBench): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_SESSION_ENDED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${CARD}`, payload: { session: 'card-session-1', pgid: 1, stopped: false, detail: 'the owner ended the interactive session' }, legacy: false })
}

const UNUSED_REQUEST_TOOLS: RequestTools = {
  treeOf: () => '',
  exists: () => false,
  cutTree: () => {},
  dryRunOf: () => null,
  addDecision: () => ({ code: 1, lines: [] }),
  causeHolds: () => null,
  closePr: () => ({ kind: 'refused', detail: 'unused' }) as never,
  closeDropped: () => [],
}

function windowRequests(made: MergeBench, argv: string[]): string[] {
  requestFromWindow(made.db, made.clock.now().toISOString(), 'window-1', requestOf(argv)!)
  return new WindowRequests(made.db, made.clock.now, UNUSED_REQUEST_TOOLS).run().map(outcome => outcome.kind)
}

interface Run {
  outcome: AnswerOutcome
  spawned: number
  published: string[]
}

async function answered({ made, trees, lease }: Card, pending: string[] = [TOUCHED], liveSession = false): Promise<Run> {
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const published: string[] = []
  let spawned = 0
  let head = sha('a')
  const answerer = claudeAnswerer(path.join(trees, 'answers'), {
    cardText: () => null,
    available: () => true,
    remoteHead: () => head,
    spawn: async (_run: AnswerRun) => {
      spawned += 1
      return 0
    },
    newSession: () => 'new-session-1',
    publish: (card) => {
      published.push(card.branch)
      head = sha('e')
    },
    pending: () => pending,
  })
  const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => liveSession ? `a live session runs in ${trees}` : null })
  return { outcome: await executor.answer(lease()), spawned, published }
}

function deniedReasons(made: MergeBench): unknown[] {
  return eventsOf(made.db, POLICY_DENIED).map(each => each.reason)
}

describe('the answer node and a card held for the owner', () => {
  it('a card held for the owner with its session ended gets no answer commit', async () => {
    const card = stoppedCard()
    sessionEnded(card.made)
    expect(windowRequests(card.made, ['hold', '--card', String(CARD), '--reason', 'the owner finishes it interactively'])).toEqual(['done'])
    expect(eventsOf(card.made.db, CARD_HELD)).toEqual([expect.objectContaining({ reason: 'the owner finishes it interactively' })])

    const run = await answered(card)

    expect(run.outcome).toMatchObject({ kind: 'denied', denial: { reason: 'held_for_owner', detail: expect.stringContaining('the owner finishes it interactively') as unknown } })
    expect(run.spawned).toBe(0)
    expect(run.published).toEqual([])
  })

  it('a released hold lets the answer commit go', async () => {
    const card = stoppedCard()
    sessionEnded(card.made)
    windowRequests(card.made, ['hold', '--card', String(CARD), '--reason', 'held'])
    expect(windowRequests(card.made, ['release', '--card', String(CARD)])).toEqual(['done'])

    const run = await answered(card)

    expect(run.outcome).toMatchObject({ kind: 'answered' })
    expect(run.published).toEqual([`feat/card-${CARD}`])
  })

  it('a hold names its reason, and a window request without one is refused at the command line', () => {
    expect(requestOf(['hold', '--card', String(CARD)])).toBeNull()
    expect(requestOf(['release', '--card', String(CARD)])).toEqual({ kind: 'release', card: CARD })
  })

  it('a draft pull request of the card holds it for the owner', async () => {
    const card = stoppedCard()
    card.made.gitHub.open({ number: PR_OF_THE_CARD, draft: true })
    card.made.tick()

    const run = await answered(card)

    expect(run.outcome).toMatchObject({ kind: 'denied', denial: { reason: 'held_for_owner', detail: expect.stringContaining(`draft pull request #${PR_OF_THE_CARD}`) as unknown } })
    expect(run.published).toEqual([])
  })

  it('a live session in the card tree holds it for the owner', async () => {
    const card = stoppedCard()

    const run = await answered(card, [TOUCHED], true)

    expect(run.outcome).toMatchObject({ kind: 'denied', denial: { reason: 'held_for_owner' } })
    expect(run.spawned).toBe(0)
    expect(deniedReasons(card.made)).toEqual(['held_for_owner'])
  })

  it('an answer commit with a path outside the card touches is refused', async () => {
    const card = stoppedCard()

    const run = await answered(card, [TOUCHED, ANOTHER_CARDS_CHANGESET])

    expect(run.outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: expect.stringContaining(ANOTHER_CARDS_CHANGESET) as unknown })
    expect(run.spawned).toBe(1)
    expect(run.published).toEqual([])
  })

  it('a refused answer commit stops the card for the owner once, with the task completed and no retry', async () => {
    const card = stoppedCard()

    const run = await answered(card, [ANOTHER_CARDS_CHANGESET])

    expect(run.outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toEqual([expect.objectContaining({ card: CARD, text: expect.stringContaining('stay uncommitted in the card tree') as unknown })])
    expect(card.made.db.prepare(`SELECT state FROM tasks WHERE queue = 'answer' AND card_id = ?`).all(CARD)).toEqual([{ state: 'completed' }])
  })

  it('a card with no admitted body refuses every answer commit instead of allowing every path', async () => {
    const run = await answered(stoppedCard(false), [TOUCHED])

    expect(run.outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: expect.stringContaining(TOUCHED) as unknown })
    expect(run.published).toEqual([])
  })

  it('an answer under a widening pushes a change to the widened path', async () => {
    const run = await answered(stoppedCard(true, [TOUCHED]), [TOUCHED])

    expect(run.outcome).toMatchObject({ kind: 'answered' })
    expect(run.published).toEqual([`feat/card-${CARD}`])
  })

  it('an answer commit inside the card touches is pushed', async () => {
    const run = await answered(stoppedCard(), [TOUCHED])

    expect(run.outcome).toMatchObject({ kind: 'answered' })
    expect(run.published).toEqual([`feat/card-${CARD}`])
  })
})

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function repository(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bus-answer-pending-'))
  roots.push(dir)
  gitIn(dir, 'init', '-q', '-b', 'main')
  for (const file of ['kept.ts', 'moved.ts', 'conflicted.ts', 'merged.ts'])
    writeFileSync(path.join(dir, file), `${file}\n`)
  gitIn(dir, 'add', '-A')
  gitIn(dir, 'commit', '-q', '-m', 'base')
  mainFetched(dir)
  return dir
}

function mainFetched(dir: string): void {
  gitIn(dir, 'update-ref', 'refs/remotes/origin/main', 'main')
}

function cardAndMainDiverged(): string {
  const dir = repository()
  gitIn(dir, 'checkout', '-q', '-b', 'feat/card')
  writeFileSync(path.join(dir, 'kept.ts'), 'card\n')
  gitIn(dir, 'commit', '-q', '-am', 'card')
  gitIn(dir, 'checkout', '-q', 'main')
  writeFileSync(path.join(dir, 'merged.ts'), 'main\n')
  writeFileSync(path.join(dir, 'from-main.ts'), 'main\n')
  gitIn(dir, 'add', '-A')
  gitIn(dir, 'commit', '-q', '-m', 'main')
  mainFetched(dir)
  gitIn(dir, 'checkout', '-q', 'feat/card')
  return dir
}

function treeAt(worktree: string): { session: string, worktree: string, branch: string } {
  return { session: 's', worktree, branch: 'feat/card' }
}

describe('the paths an answer commit would push', () => {
  it('names the committed, renamed, modified and untracked paths since the remote head', () => {
    const dir = repository()
    writeFileSync(path.join(dir, 'committed.ts'), 'x\n')
    gitIn(dir, 'add', '-A')
    gitIn(dir, 'commit', '-q', '-m', 'the session committed')
    renameSync(path.join(dir, 'moved.ts'), path.join(dir, 'renamed.ts'))
    gitIn(dir, 'add', '-A')
    writeFileSync(path.join(dir, 'kept.ts'), 'changed\n')
    writeFileSync(path.join(dir, 'untracked.ts'), 'new\n')

    expect(pendingPathsOf(treeAt(dir)).sort()).toEqual(['committed.ts', 'kept.ts', 'renamed.ts', 'untracked.ts'])
  })

  it('mid-merge, a path the merged branch brought unchanged is not the answer\'s', () => {
    const dir = repository()
    gitIn(dir, 'checkout', '-q', '-b', 'feat/card')
    writeFileSync(path.join(dir, 'conflicted.ts'), 'card\n')
    gitIn(dir, 'commit', '-q', '-am', 'card')
    gitIn(dir, 'checkout', '-q', 'main')
    writeFileSync(path.join(dir, 'conflicted.ts'), 'main\n')
    writeFileSync(path.join(dir, 'merged.ts'), 'main\n')
    gitIn(dir, 'commit', '-q', '-am', 'main')
    mainFetched(dir)
    gitIn(dir, 'checkout', '-q', 'feat/card')
    expect(() => gitIn(dir, 'merge', '-q', 'main')).toThrow()

    expect(pendingPathsOf(treeAt(dir))).toEqual(['conflicted.ts'])
  })

  it('a merge of main into the card branch adds none of main\'s paths to the pending ones', () => {
    const dir = cardAndMainDiverged()
    gitIn(dir, 'merge', '-q', '--no-edit', 'origin/main')
    writeFileSync(path.join(dir, 'answered.ts'), 'answer\n')

    expect(pendingPathsOf(treeAt(dir)).sort()).toEqual(['answered.ts', 'kept.ts'])
  })

  it('a rebase onto main adds none of main\'s paths to the pending ones', () => {
    const dir = cardAndMainDiverged()
    gitIn(dir, 'rebase', '-q', 'origin/main')
    writeFileSync(path.join(dir, 'answered.ts'), 'answer\n')
    gitIn(dir, 'add', '-A')
    gitIn(dir, 'commit', '-q', '-m', 'answer')

    expect(pendingPathsOf(treeAt(dir)).sort()).toEqual(['answered.ts', 'kept.ts'])
  })
})

describe('a live session in the card tree', () => {
  it('is seen at the tree and in a subdirectory of it, and not in a sibling', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bus-answer-live-'))
    roots.push(dir)
    const tree = path.join(dir, 'mc-905')
    mkdirSync(path.join(tree, 'scripts'), { recursive: true })
    const real = realpathSync(tree)
    const listed = (...cwds: string[]) => () => ({ kind: 'listed' as const, listing: cwds.flatMap(cwd => ['p1', 'fcwd', `n${cwd}`]).join('\n') })

    expect(liveSessionIn(treeAt(tree), listed(real))).toContain(real)
    expect(liveSessionIn(treeAt(tree), listed(path.join(real, 'scripts')))).toContain(path.join(real, 'scripts'))
    expect(liveSessionIn(treeAt(tree), listed(`${real}-sibling`))).toBeNull()
    expect(liveSessionIn(treeAt(tree), listed())).toBeNull()
  })

  it('counts the card as held when the sessions cannot be read', () => {
    expect(liveSessionIn(treeAt('/nowhere'), () => ({ kind: 'unreadable', why: 'spawn lsof ENOENT' }))).toContain('spawn lsof ENOENT')
  })
})

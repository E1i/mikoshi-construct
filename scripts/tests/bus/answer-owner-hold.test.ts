import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/answer-executor.js'
import type { AnswerRun } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_HELD, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, POLICY_DENIED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
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

function stoppedCard(): Card {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-hold-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: `a question on card #${CARD}` }, legacy: false })
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
  const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => liveSession })
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

    expect(run.outcome).toMatchObject({ kind: 'denied', denial: { reason: 'outside_touches', detail: expect.stringContaining(ANOTHER_CARDS_CHANGESET) as unknown } })
    expect(run.spawned).toBe(1)
    expect(run.published).toEqual([])
  })

  it('an answer commit inside the card touches is pushed', async () => {
    const run = await answered(stoppedCard(), [TOUCHED])

    expect(run.outcome).toMatchObject({ kind: 'answered' })
    expect(run.published).toEqual([`feat/card-${CARD}`])
  })
})

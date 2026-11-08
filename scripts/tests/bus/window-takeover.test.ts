import type { Lease } from '../../core/lease.js'
import type { AnswerRun } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { RequestOutcome, RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_HELD, CARD_RELEASED, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, CARD_TAKEOVER, PR_OPENED, QUESTION_AGENT, QUESTION_OWNER, WITNESS_RECORDED } from '../../core/events.js'
import { failTask, leaseNext } from '../../core/lease.js'
import { cardBodyShaOfCard, queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { ownerHoldOf } from '../../nodes/answer/answer-source.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { recordDecision } from '../../policy/decisions.js'
import { requestFromWindow, requestOf, TAKEOVER_AFTER_MINUTES, WindowRequests } from '../../window/window-requests.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 905
const PR_OF_THE_CARD = CARD - 100
const TOUCHED = 'scripts/a.ts'
const REASON = 'the owner stop has no lift and the bus has no route'
const MINUTE = 60_000

const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

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

interface Card {
  made: MergeBench
  trees: string
}

function startedCard(): Card {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-takeover-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  return { made, trees }
}

function stopped(made: MergeBench, reason: string, dedupe = 'first'): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}:${dedupe}`, payload: { reason, detail: `a question on card #${CARD}` }, legacy: false })
}

function sessionEnded(made: MergeBench): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_SESSION_ENDED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_SESSION_ENDED}:${CARD}`, payload: { session: 'card-session-1', pgid: 1, stopped: false, detail: 'ended' }, legacy: false })
}

function prOpened(made: MergeBench): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:shift:shift-1', cardId: CARD, pr: PR_OF_THE_CARD, head: null, dedupeKey: `${PR_OPENED}:${CARD}:${PR_OF_THE_CARD}`, payload: { pr: PR_OF_THE_CARD }, legacy: false })
}

function ownerStoppedCard(): Card {
  const card = startedCard()
  stopped(card.made, QUESTION_OWNER)
  card.made.tick()
  return card
}

function request(made: MergeBench, argv: string[]): RequestOutcome {
  requestFromWindow(made.db, made.clock.now().toISOString(), 'window-1', requestOf(argv)!)
  return new WindowRequests(made.db, made.clock.now, UNUSED_REQUEST_TOOLS).run()[0]!
}

function takeover(made: MergeBench): RequestOutcome {
  return request(made, ['takeover', '--card', String(CARD), '--reason', REASON])
}

function heldOrTakenOver(made: MergeBench): unknown[] {
  return [...eventsOf(made.db, CARD_HELD), ...eventsOf(made.db, CARD_TAKEOVER)]
}

function leaseAnswer(made: MergeBench): Lease {
  return leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!
}

function answerStatesOf(made: MergeBench): string[] {
  const rows = made.db.prepare(`SELECT state FROM tasks WHERE card_id = ? AND queue = 'answer'`).all(CARD) as { state: string }[]
  return rows.map(row => row.state)
}

function agentStoppedCard(): Card {
  const card = startedCard()
  stopped(card.made, QUESTION_AGENT)
  sessionEnded(card.made)
  return card
}

function answerExecutor({ made, trees }: Card): AnswerExecutor {
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  let head = sha('a')
  const answerer = claudeAnswerer(path.join(trees, 'answers'), {
    cardText: () => null,
    available: () => true,
    remoteHead: () => head,
    spawn: async (_run: AnswerRun) => 0,
    newSession: () => 'new-session-1',
    publish: () => {
      head = sha('e')
    },
    pending: () => [TOUCHED],
  })
  return new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => null })
}

describe('a window takeover of a card the bus has no route for', () => {
  it('takeover of a stuck card holds it', () => {
    const { made } = ownerStoppedCard()

    expect(takeover(made)).toMatchObject({ kind: 'done', detail: expect.stringContaining(REASON) as unknown })

    expect(eventsOf(made.db, CARD_HELD)).toEqual([expect.objectContaining({ reason: REASON })])
    expect(eventsOf(made.db, CARD_TAKEOVER)).toEqual([expect.objectContaining({ reason: REASON, ground: expect.stringContaining('owner stop') as unknown })])
    const actors = made.db.prepare(`SELECT actor FROM events WHERE type IN ('${CARD_HELD}', '${CARD_TAKEOVER}')`).all() as { actor: string }[]
    expect(actors.map(row => row.actor)).toEqual(['worker:window:window-1', 'worker:window:window-1'])
    expect(ownerHoldOf(made.db, CARD)).toBe(`card #${CARD} is taken over by the window: ${REASON}`)
  })

  it('takeover refused while the bus has a route: a live answer task', () => {
    const { made } = ownerStoppedCard()
    queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: CARD, stop: 1 })

    expect(takeover(made)).toMatchObject({ kind: 'refused', detail: expect.stringContaining('the answer task') as unknown })

    expect(heldOrTakenOver(made)).toEqual([])
    expect(ownerHoldOf(made.db, CARD)).toBeNull()
  })

  it('takeover refused while the bus has a route: an open pull request in review', () => {
    const { made } = ownerStoppedCard()
    made.gitHub.open({ number: PR_OF_THE_CARD })
    made.tick()
    queueTask(made.db, made.clock.now().toISOString(), { queue: 'review', cardId: CARD, pr: PR_OF_THE_CARD, head: sha('a') })

    expect(takeover(made)).toMatchObject({ kind: 'refused', detail: expect.stringContaining('the review task') as unknown })

    expect(heldOrTakenOver(made)).toEqual([])
  })

  it('a started card with no pull request and no session end is still refused', () => {
    const { made } = startedCard()

    expect(takeover(made)).toMatchObject({ kind: 'refused', detail: expect.stringContaining('has not ended') as unknown })

    expect(heldOrTakenOver(made)).toEqual([])
  })

  it('a started card whose pull request is open and red with its answer task withdrawn is taken over after the wait', () => {
    const { made } = startedCard()
    prOpened(made)
    made.gitHub.open({ number: PR_OF_THE_CARD, required: 'failure', failed: ['required'] })
    made.tick()
    failTask(made.db, made.clock.now().toISOString(), leaseAnswer(made), { reason: 'held_for_owner', withdraw: true })
    expect(answerStatesOf(made)).toEqual(['withdrawn'])

    expect(takeover(made)).toMatchObject({ kind: 'refused', detail: expect.stringContaining(`under the ${TAKEOVER_AFTER_MINUTES}`) as unknown })
    expect(heldOrTakenOver(made)).toEqual([])

    made.clock.advance(TAKEOVER_AFTER_MINUTES * MINUTE)
    expect(takeover(made)).toMatchObject({ kind: 'done' })
    expect(eventsOf(made.db, CARD_TAKEOVER)).toEqual([expect.objectContaining({ reason: REASON, ground: expect.stringContaining('no answer or launch task ran') as unknown })])
  })

  it('a pull request opened before the latest start does not end that session', () => {
    const { made } = startedCard()
    prOpened(made)
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}:again`, payload: { session: 'card-session-2', worktree: 'unused', branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })

    expect(takeover(made)).toMatchObject({ kind: 'refused', detail: expect.stringContaining('has not ended') as unknown })
    expect(heldOrTakenOver(made)).toEqual([])
  })

  it('release ends the takeover', async () => {
    const card = startedCard()
    const { made } = card
    stopped(made, QUESTION_AGENT)
    sessionEnded(made)
    made.clock.advance(TAKEOVER_AFTER_MINUTES * MINUTE)
    expect(takeover(made)).toMatchObject({ kind: 'done' })
    made.tick()

    await expect(answerExecutor(card).answer(leaseAnswer(made))).resolves.toMatchObject({ kind: 'denied', denial: { reason: 'held_for_owner', detail: expect.stringContaining(REASON) as unknown } })

    expect(request(made, ['release', '--card', String(CARD)])).toMatchObject({ kind: 'done', detail: expect.stringContaining('queued again') as unknown })
    expect(eventsOf(made.db, CARD_RELEASED)).toHaveLength(1)
    expect(ownerHoldOf(made.db, CARD)).toBeNull()
    await expect(answerExecutor(card).answer(leaseAnswer(made))).resolves.toMatchObject({ kind: 'answered' })
  })

  it('a takeover release leaves an answer withdrawn before the takeover opened withdrawn', () => {
    const { made } = agentStoppedCard()
    made.tick()
    failTask(made.db, made.clock.now().toISOString(), leaseAnswer(made), { reason: 'held_for_owner', withdraw: true })
    made.clock.advance(TAKEOVER_AFTER_MINUTES * MINUTE)
    expect(takeover(made)).toMatchObject({ kind: 'done' })

    expect(request(made, ['release', '--card', String(CARD)]).detail).not.toContain('queued again')

    expect(answerStatesOf(made)).toEqual(['withdrawn'])
  })

  it('a takeover release leaves an answer withdrawn for another reason withdrawn', () => {
    const { made } = agentStoppedCard()
    made.clock.advance(TAKEOVER_AFTER_MINUTES * MINUTE)
    expect(takeover(made)).toMatchObject({ kind: 'done' })
    made.tick()
    failTask(made.db, made.clock.now().toISOString(), leaseAnswer(made), { reason: 'nothing_to_answer', withdraw: true })

    expect(request(made, ['release', '--card', String(CARD)]).detail).not.toContain('queued again')

    expect(answerStatesOf(made)).toEqual(['withdrawn'])
  })

  it('a second release after a takeover queues nothing again', async () => {
    const card = agentStoppedCard()
    const { made } = card
    made.clock.advance(TAKEOVER_AFTER_MINUTES * MINUTE)
    expect(takeover(made)).toMatchObject({ kind: 'done' })
    made.tick()
    await answerExecutor(card).answer(leaseAnswer(made))
    expect(request(made, ['release', '--card', String(CARD)]).detail).toContain('queued again')

    expect(request(made, ['release', '--card', String(CARD)]).detail).not.toContain('queued again')

    expect(answerStatesOf(made)).toEqual(['queued'])
  })

  it('a stop that needs a task waits the named minutes, measured from the last move of the card', () => {
    const { made } = startedCard()
    stopped(made, 'fault')
    made.clock.advance((TAKEOVER_AFTER_MINUTES - 1) * MINUTE)

    expect(takeover(made)).toMatchObject({ kind: 'refused', detail: expect.stringContaining(`under the ${TAKEOVER_AFTER_MINUTES}`) as unknown })
    expect(heldOrTakenOver(made)).toEqual([])

    made.clock.advance(MINUTE)
    expect(takeover(made)).toMatchObject({ kind: 'done' })
    expect(eventsOf(made.db, CARD_TAKEOVER)).toEqual([expect.objectContaining({ ground: `no answer or launch task ran for ${TAKEOVER_AFTER_MINUTES} minutes` })])
  })

  it('green witnesses with no open pull request are a ground at once', () => {
    const { made } = startedCard()
    sessionEnded(made)
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: WITNESS_RECORDED, actor: 'worker:witness:1', cardId: CARD, pr: null, head: sha('b'), dedupeKey: `${WITNESS_RECORDED}:${CARD}`, payload: { head: sha('b'), base: sha('1'), verdict: 'green', detail: 'green' }, legacy: false })

    expect(takeover(made)).toMatchObject({ kind: 'done' })
    expect(eventsOf(made.db, CARD_TAKEOVER)).toEqual([expect.objectContaining({ ground: expect.stringContaining(sha('b')) as unknown })])
  })

  it('a card with no ground is refused with the reason named', () => {
    const { made } = startedCard()
    sessionEnded(made)

    expect(takeover(made)).toMatchObject({ kind: 'refused', detail: expect.stringContaining('the bus has its route') as unknown })
    expect(heldOrTakenOver(made)).toEqual([])
  })

  it('a red pull request on a card with no recorded move is refused instead of throwing in the tick', () => {
    const { made } = startedCard()
    const moveless = CARD + 1
    made.db.prepare(`INSERT INTO prs (pr, card_id, state, ci, event_id) VALUES (?, ?, 'open', 'red', 1)`).run(moveless - 100, moveless)

    expect(request(made, ['takeover', '--card', String(moveless), '--reason', REASON])).toMatchObject({ kind: 'refused', detail: expect.stringContaining('no recorded turn or task') as unknown })
    expect(heldOrTakenOver(made)).toEqual([])
  })

  it('a red pull request after the named minutes is a ground', () => {
    const { made } = startedCard()
    sessionEnded(made)
    made.db.prepare(`INSERT INTO prs (pr, card_id, state, ci, event_id) VALUES (?, ?, 'open', 'red', 1)`).run(PR_OF_THE_CARD, CARD)
    made.clock.advance(TAKEOVER_AFTER_MINUTES * MINUTE)

    expect(takeover(made)).toMatchObject({ kind: 'done' })
  })

  it('a card already taken over is refused until it is released', () => {
    const { made } = ownerStoppedCard()
    takeover(made)

    expect(takeover(made)).toMatchObject({ kind: 'refused', detail: expect.stringContaining('release it before a takeover') as unknown })
    expect(eventsOf(made.db, CARD_TAKEOVER)).toHaveLength(1)
  })

  it('a takeover names its card and reason at the command line', () => {
    expect(requestOf(['takeover', '--card', String(CARD)])).toBeNull()
    expect(requestOf(['takeover', '--reason', REASON])).toBeNull()
    expect(requestOf(['takeover', '--card', String(CARD), '--reason', REASON])).toEqual({ kind: 'takeover', card: CARD, reason: REASON })
  })
})

describe('an amend against a decision on an admitted card', () => {
  const ADMITTED_BODY = 'aaaa1111'
  const AMENDED_BODY = 'bbbb2222'

  function admitBody(made: MergeBench, bodySha: string): void {
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${bodySha}`, payload: { lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}-${bodySha}`, bodySha }, legacy: false })
  }

  function liveAnswers(made: MergeBench): string[] {
    return (made.db.prepare(`SELECT task_key FROM tasks WHERE card_id = ? AND queue = 'answer' AND state IN ('queued', 'leased') ORDER BY task_key`).all(CARD) as { task_key: string }[]).map(row => row.task_key)
  }

  function redCardOnTheAdmittedBody(): MergeBench {
    const { made } = startedCard()
    admitBody(made, ADMITTED_BODY)
    prOpened(made)
    made.gitHub.open({ number: PR_OF_THE_CARD, required: 'failure', failed: ['required'] })
    made.tick()
    return made
  }

  it('an amend of an admitted card stays a full readmission', () => {
    const made = redCardOnTheAdmittedBody()
    expect(liveAnswers(made)).toEqual([expect.stringMatching(new RegExp(`:card-body-${ADMITTED_BODY}$`))])

    recordDecision(made.db, { ts: made.clock.now().toISOString(), decisionId: 905, text: 'keep the body as admitted', cards: [CARD] })
    made.tick()
    expect(cardBodyShaOfCard(made.db, CARD)).toBe(ADMITTED_BODY)

    admitBody(made, AMENDED_BODY)
    made.tick()

    expect(cardBodyShaOfCard(made.db, CARD)).toBe(AMENDED_BODY)
    expect(liveAnswers(made)).toEqual([expect.stringMatching(new RegExp(`:card-body-${AMENDED_BODY}$`))])
  })
})

import type { DatabaseSync } from 'node:sqlite'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, closeOwnerWait, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, DECISION_RECORDED, OUTSIDE_TOUCHES, QUESTION_AGENT } from '../../core/events.js'
import { ANSWER_SOURCE } from '../../core/inbox.js'
import { completeTask, leaseNext } from '../../core/lease.js'
import { QUEUE_ACTOR } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { heldSessionStop } from '../../nodes/launch/launch-worker.js'
import { sameDecisionWords, sayToOwnerChannel } from '../../owner/channel.js'
import { recordDecision } from '../../policy/decisions/index.js'
import { cardDecisionCommand } from '../../policy/shards.js'
import { decisionsAdder } from '../../window/window-request-tools.js'
import { runRequest, WindowRequests } from '../../window/window-requests.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1784
const PR = 1684
const TOUCHED = 'scripts/a.ts'
const OUTSIDE = 'scripts/core/layer-map.ts'
const QUESTION = 'may the retry back off?'
const ANSWERED = 'the retry backs off twice, then stops'
const DECISION = 481

interface Card {
  made: MergeBench
  root: string
  wait: string
}

const cards: Card[] = []

afterEach(() => {
  for (const { made, root } of cards.splice(0)) {
    made.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function body(): string {
  return `card: #${CARD} a-card [implement/construct/M/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: auto\nwho: shift\n\nDo it.\n`
}

function stoppedByItsAgent(stop: Record<string, unknown> = { reason: QUESTION_AGENT, detail: QUESTION }, withAPr = true): Card {
  const made = mergeBench()
  const root = mkdtempSync(path.join(tmpdir(), 'card-decision-closes-its-wait-'))
  const ts = made.clock.now().toISOString()
  const text = body()
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}`, text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: path.join(root, `mc-${CARD}`), branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  if (withAPr)
    made.gitHub.open({ number: PR, head: sha('a'), review: 'success' })
  made.tick()
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: withAPr ? PR : null, head: withAPr ? sha('a') : null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: stop, legacy: false })
  made.tick()
  const round = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')
  if (round !== null)
    completeTask(made.db, made.clock.now().toISOString(), round, [])
  const wait = openOwnerWait(made.db, made.clock.now().toISOString(), 'worker:answer:worker-1', { need: 'decision', text: `card #${CARD} waits for the owner: an answer round after its ${QUESTION_AGENT} stop left nothing`, command: cardDecisionCommand(CARD), card: CARD, ...(withAPr ? { pr: PR } : {}) })
  made.tick()
  const card = { made, root, wait }
  cards.push(card)
  return card
}

function waitOf(db: DatabaseSync, wait: string): { state: string, answer: string | null } {
  reduce(db)
  return db.prepare('SELECT state, answer FROM owner_waits WHERE id = ?').get(wait) as { state: string, answer: string | null }
}

function answerTasks(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT task_key FROM tasks WHERE queue = 'answer' AND card_id = ? AND state IN ('queued', 'leased') ORDER BY task_key`).all(CARD) as { task_key: string }[]).map(row => row.task_key)
}

function decided({ made }: Card, text = ANSWERED): void {
  recordDecision(made.db, { ts: made.clock.now().toISOString(), decisionId: DECISION, text, cards: [CARD] })
  made.tick()
  made.tick()
}

function windowOf({ made, root }: Card): { channel: string, run: (...argv: string[]) => { kind: string, detail: string } } {
  const channel = path.join(root, 'owner-answers')
  const decisions = path.join(root, 'owner-decisions.md')
  writeFileSync(decisions, '# Owner decisions\n\n- D-1 · 2026-10-08 — first. · decisions:add\n')
  const refuse = (): never => {
    throw new Error('the owner word on a wait uses no tool but the decisions adder')
  }
  const tools = { treeOf: refuse, exists: existsSync, cutTree: refuse, dryRunOf: refuse, addDecision: decisionsAdder(made.db, decisions, made.clock.now), causeHolds: refuse, closePr: refuse, closeDropped: () => [] }
  return {
    channel,
    run: (...argv) => {
      expect(runRequest(argv, made.db, made.clock.now(), 'test', () => {})).toBe(0)
      const [outcome] = new WindowRequests(made.db, made.clock.now, tools, channel).run()
      made.tick()
      made.tick()
      return outcome!
    },
  }
}

describe('one owner word on a card is one act', () => {
  it('a --card decision closes the question.agent wait of its card', () => {
    const card = stoppedByItsAgent()
    expect(waitOf(card.made.db, card.wait).state).toBe('open')

    decided(card)

    expect(waitOf(card.made.db, card.wait)).toEqual({ state: 'closed', answer: `D-${DECISION}` })
  })

  it('a --card decision closes only the wait it names when it names one', () => {
    const card = stoppedByItsAgent()
    const other = openOwnerWait(card.made.db, card.made.clock.now().toISOString(), QUEUE_ACTOR, { need: 'command', text: 'which lane?', command: 'pnpm lanes:check', card: CARD })
    reduce(card.made.db)

    decided(card, `${card.wait}: ${ANSWERED}`)

    expect(waitOf(card.made.db, card.wait).state).toBe('closed')
    expect(waitOf(card.made.db, other).state).toBe('open')
  })

  it('a --card decision on a question.agent stop queues one answer task for its card', () => {
    const card = stoppedByItsAgent()
    expect(answerTasks(card.made.db)).toEqual([])

    decided(card)

    const tasks = answerTasks(card.made.db)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatch(new RegExp(`:decision-${DECISION}$`))
  })

  it('the owner channel word naming Q<N> binds a decision to the card of the wait and queues one answer task', () => {
    const card = stoppedByItsAgent()
    const window = windowOf(card)
    sayToOwnerChannel(window.channel, `${card.wait}: ${ANSWERED}`, card.made.clock.now())

    expect(window.run('owner.wait.close', '--id', card.wait, '--from', ANSWER_SOURCE).kind).toBe('done')

    expect(waitOf(card.made.db, card.wait).state).toBe('closed')
    const recorded = eventsOf(card.made.db, DECISION_RECORDED)
    expect(recorded).toEqual([expect.objectContaining({ decision_id: 2, scope: [CARD], text: `${card.wait}: ${ANSWERED}` })])
    const tasks = answerTasks(card.made.db)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatch(/:decision-2$/)

    sayToOwnerChannel(window.channel, `${card.wait}: ${ANSWERED}`, card.made.clock.now())
    expect(window.run('decisions:add', '--from', ANSWER_SOURCE, '--card', `#${CARD}`, `[owner] ${card.wait}: ${ANSWERED}`).kind).toBe('done')

    expect(eventsOf(card.made.db, DECISION_RECORDED)).toHaveLength(1)
    expect(answerTasks(card.made.db)).toEqual(tasks)
  })

  it('an owner word that no widening is needed lifts the outside touches launch hold', () => {
    const outside = { reason: QUESTION_AGENT, detail: `the touches do not cover ${OUTSIDE}; widen them`, code: OUTSIDE_TOUCHES, paths: [OUTSIDE] }
    const byDecision = stoppedByItsAgent(outside)
    expect(heldSessionStop(byDecision.made.db, CARD)).toMatchObject({ code: OUTSIDE_TOUCHES, paths: [OUTSIDE] })
    decided(byDecision, 'расширение не нужно')
    expect(heldSessionStop(byDecision.made.db, CARD)).toBeNull()

    const byWord = stoppedByItsAgent(outside)
    expect(heldSessionStop(byWord.made.db, CARD)).not.toBeNull()
    closeOwnerWait(byWord.made.db, byWord.made.clock.now().toISOString(), QUEUE_ACTOR, byWord.wait, 'расширение не нужно', 1)
    reduce(byWord.made.db)
    expect(heldSessionStop(byWord.made.db, CARD)).toBeNull()
  })

  it('the owner channel word closing a command wait of the card binds a decision to the card', () => {
    const card = stoppedByItsAgent()
    const command = openOwnerWait(card.made.db, card.made.clock.now().toISOString(), QUEUE_ACTOR, { need: 'command', text: 'widen the touches?', command: 'pnpm intake --admit <draft>', card: CARD })
    reduce(card.made.db)
    const window = windowOf(card)
    sayToOwnerChannel(window.channel, `${command}: ${ANSWERED}`, card.made.clock.now())

    expect(window.run('owner.wait.close', '--id', command, '--from', ANSWER_SOURCE).kind).toBe('done')

    expect(waitOf(card.made.db, command).state).toBe('closed')
    expect(eventsOf(card.made.db, DECISION_RECORDED)).toEqual([expect.objectContaining({ scope: [CARD], text: `${command}: ${ANSWERED}` })])
  })

  it('the same words for the card and another card write a new decision when the bound one names only the card', () => {
    const card = stoppedByItsAgent()
    const window = windowOf(card)
    sayToOwnerChannel(window.channel, `${card.wait}: ${ANSWERED}`, card.made.clock.now())
    expect(window.run('owner.wait.close', '--id', card.wait, '--from', ANSWER_SOURCE).kind).toBe('done')
    expect(eventsOf(card.made.db, DECISION_RECORDED)).toEqual([expect.objectContaining({ scope: [CARD] })])

    sayToOwnerChannel(window.channel, `${card.wait}: ${ANSWERED}`, card.made.clock.now())
    expect(window.run('decisions:add', '--from', ANSWER_SOURCE, '--supersedes', 'D-2', '--card', `#${CARD}`, '--card', `#${CARD + 1}`, `[owner] ${card.wait}: ${ANSWERED}`).kind).toBe('done')

    expect(eventsOf(card.made.db, DECISION_RECORDED)).toEqual([expect.objectContaining({ scope: [CARD] }), expect.objectContaining({ scope: [CARD, CARD + 1] })])
  })

  it('a wait of the card closed before an outside touches stop does not lift that stop', () => {
    const outside = { reason: QUESTION_AGENT, detail: `the touches do not cover ${OUTSIDE}; widen them`, code: OUTSIDE_TOUCHES, paths: [OUTSIDE] }
    const card = stoppedByItsAgent(outside)
    closeOwnerWait(card.made.db, card.made.clock.now().toISOString(), QUEUE_ACTOR, card.wait, 'расширение не нужно', 1)
    reduce(card.made.db)
    expect(heldSessionStop(card.made.db, CARD)).toBeNull()
    card.made.tick()

    appendEvent(card.made.db, { ts: card.made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: PR, head: sha('a'), dedupeKey: `${CARD_STOPPED}:${CARD}:again`, payload: outside, legacy: false })
    reduce(card.made.db)

    expect(heldSessionStop(card.made.db, CARD)).toMatchObject({ code: OUTSIDE_TOUCHES, paths: [OUTSIDE] })
  })

  it('a --card decision on a question.agent stop of a card with no open pull request queues no answer task', () => {
    const card = stoppedByItsAgent({ reason: QUESTION_AGENT, detail: QUESTION }, false)

    decided(card)

    expect(waitOf(card.made.db, card.wait)).toEqual({ state: 'closed', answer: `D-${DECISION}` })
    expect(answerTasks(card.made.db)).toEqual([])
  })

  it('two different named waits with no words of their own are not the same decision words', () => {
    expect(sameDecisionWords('Q1:', '[owner] Q2')).toBe(false)
  })
})

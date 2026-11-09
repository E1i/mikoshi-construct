import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED, POLICY_DENIED, QUESTION_AGENT, QUESTION_OWNER } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { AnswerExecutor, questionAskedTwiceLine } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer, ownerQuestionPath } from '../../nodes/answer/answerer.js'
import { recordDecision } from '../../policy/decisions.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1633
const CARD_SESSION = 'card-session-1'
const QUESTION = 'which of the two readings of the brief does the card mean?'
const ANOTHER_QUESTION = 'does the second reading keep the first test?'

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
  stopOnTheAgent: (question: string) => void
  asks: (question: string) => Promise<unknown>
}

function startedCard(): Card {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-question-loop-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const answers = path.join(trees, 'answers')
  const ts = (): string => made.clock.now().toISOString()
  appendEvent(made.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}` }, legacy: false })
  appendEvent(made.db, { ts: ts(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: CARD_SESSION, worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  let stops = 0
  const stopOnTheAgent = (question: string): void => {
    stops += 1
    appendEvent(made.db, { ts: ts(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}:agent-${stops}`, payload: { reason: QUESTION_AGENT, detail: question }, legacy: false })
    made.tick()
  }
  const asks = async (question: string): Promise<unknown> => {
    const lease = leaseNext(made.db, ts(), 'answer', 'worker:answer:worker-1')!
    const answerer = claudeAnswerer(answers, {
      cardText: () => null,
      available: () => true,
      remoteHead: () => sha('a'),
      spawn: async () => {
        writeFileSync(ownerQuestionPath(answers, CARD_SESSION, lease.leaseGen), `${question}\n`)
        return 0
      },
      newSession: () => CARD_SESSION,
      publish: () => {},
    })
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }, dirty: () => false, liveSession: () => null })
    const outcome = await executor.answer(lease)
    made.tick()
    return outcome
  }
  return { made, stopOnTheAgent, asks }
}

describe('a question the answer session repeats', () => {
  it('one question twice in a row stops with a wait', async () => {
    const card = startedCard()
    card.stopOnTheAgent(QUESTION)

    expect(await card.asks(`  ${QUESTION}  `)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: QUESTION })
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toEqual([expect.objectContaining({ text: questionAskedTwiceLine(CARD, QUESTION) })])
    expect(eventsOf(card.made.db, CARD_STOPPED).map(stop => stop.reason)).toEqual([QUESTION_AGENT, QUESTION_OWNER])
    expect(leaseNext(card.made.db, card.made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')).toBeNull()
  })

  it('a different question stays with the agent', async () => {
    const card = startedCard()
    card.stopOnTheAgent(QUESTION)

    expect(await card.asks(ANOTHER_QUESTION)).toMatchObject({ kind: 'stopped', reason: QUESTION_AGENT, detail: ANOTHER_QUESTION })
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toEqual([])
  })

  it('the second ask of a new question still goes to the agent once, the repeat after it waits', async () => {
    const card = startedCard()
    card.stopOnTheAgent(QUESTION)

    expect(await card.asks(ANOTHER_QUESTION)).toMatchObject({ kind: 'stopped', reason: QUESTION_AGENT })
    expect(await card.asks(ANOTHER_QUESTION)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toHaveLength(1)
  })

  it('a repeat under a decision bound to the card after the stop goes again without a wait', async () => {
    const card = startedCard()
    card.stopOnTheAgent(QUESTION)
    recordDecision(card.made.db, { ts: card.made.clock.now().toISOString(), decisionId: 901, text: 'the card means the first reading', cards: [CARD] })
    card.made.tick()

    expect(await card.asks(QUESTION)).toMatchObject({ kind: 'denied', denial: { reason: 'repeated_stop' } })
    expect(eventsOf(card.made.db, POLICY_DENIED)).toEqual([expect.objectContaining({ reason: 'repeated_stop' })])
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toEqual([])
  })
})

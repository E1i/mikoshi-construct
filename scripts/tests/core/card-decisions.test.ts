import type { ShiftTask } from '../../../src/card/task-file.js'
import type { CardDecisionTurn } from '../../core/card-decisions.js'
import type { QueuedTask } from '../../core/queue.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { answerDecisionOfKey, busCardDecisions, CARD_DECISIONS_HEADING, cardDecisionBlock, cardDecisionTurnQuery, continuesTheCard, decisionOfKey, decisionSegment, oneContinuationPerCard, withCardDecisions } from '../../core/card-decisions.js'
import { openBus } from '../../core/db.js'
import { reduce } from '../../core/reducer.js'
import { recordDecision } from '../../policy/decisions/index.js'
import { cardDecisionLines } from '../../policy/shards.js'
import { busProjections } from '../../supervisor/composition.js'

const NOW = new Date('2026-11-08T10:00:00Z')
const CARD = 1719
const OTHER_CARD = 1720
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busWithDecisions(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'card-decisions-'))
  roots.push(root)
  const file = path.join(root, 'bus.db')
  const db = openBus(file)
  recordDecision(db, { ts: NOW.toISOString(), decisionId: 1, text: 'every card.', cards: [] })
  recordDecision(db, { ts: NOW.toISOString(), decisionId: 2, text: 'this card.', cards: [CARD] })
  recordDecision(db, { ts: NOW.toISOString(), decisionId: 3, text: 'another card.', cards: [OTHER_CARD] })
  reduce(db, 'pending', busProjections())
  db.close()
  return file
}

function turn(fields: Partial<CardDecisionTurn>): CardDecisionTurn {
  return { decision: 2, decided_at: 10, card_id: CARD, pr: 900, head: 'a'.repeat(40), card_body: null, last_review: null, owner_stop: null, ...fields }
}

function answerTask(cardId: number, decision?: number): QueuedTask {
  return { queue: 'answer', cardId, pr: 900, head: 'a'.repeat(40), decision }
}

describe('the decision id in an answer task key', () => {
  it('an answer task carries its decision as the key segment, and the segment reads back', () => {
    expect(decisionSegment({ queue: 'answer', decision: 378 })).toBe(':decision-378')
    expect(decisionSegment({ queue: 'answer' })).toBe('')
    expect(decisionOfKey('answer:1719:pr-900:card-body-af19faa6:decision-378')).toBe(378)
    expect(decisionOfKey('answer:1719:pr-900:card-body-af19faa6')).toBeUndefined()
    expect(decisionOfKey(undefined)).toBeUndefined()
  })

  it('only an answer task carries a decision id, and only a positive integer one', () => {
    expect(() => decisionSegment({ queue: 'review', decision: 378 })).toThrow('only an answer task carries a decision id')
    expect(() => decisionSegment({ queue: 'answer', decision: 0 })).toThrow('only an answer task carries a decision id')
    expect(answerDecisionOfKey('review', 'review:1719:decision-378')).toBeUndefined()
    expect(answerDecisionOfKey('answer', 'answer:1719:decision-378')).toBe(378)
  })
})

describe('the decisions of a card in a session prompt', () => {
  it('a card sees the decisions bound to it and the unbound ones, never another card\'s', () => {
    const file = busWithDecisions()
    expect(busCardDecisions(file, cardDecisionLines, () => NOW)(CARD)).toEqual(['D-1: every card.', 'D-2: this card.'])
    const db = openBus(file)
    expect(cardDecisionLines(db, OTHER_CARD, NOW)).toEqual(['D-1: every card.', 'D-3: another card.'])
    db.close()
  })

  it('a bus that does not exist yet gives no decisions', () => {
    expect(busCardDecisions(path.join(tmpdir(), 'no-such-dir-card-decisions', 'bus.db'), () => ['D-1: never read.'])(CARD)).toEqual([])
  })

  it('the block opens with the heading, and no decisions give no block and leave the task as it was', () => {
    expect(cardDecisionBlock(['D-2: this card.'])).toEqual([CARD_DECISIONS_HEADING, 'D-2: this card.'])
    expect(cardDecisionBlock([])).toEqual([])
    const task = { body: `#${CARD} body`, card: { id: CARD } } as unknown as ShiftTask
    expect(withCardDecisions(task, ['D-2: this card.']).body).toBe(`#${CARD} body\n\n${CARD_DECISIONS_HEADING}\nD-2: this card.`)
    expect(withCardDecisions(task, [])).toBe(task)
  })
})

describe('a card decision continues the card', () => {
  const pastTheLimit = (): boolean => true
  const withinTheLimit = (): boolean => false

  it('a decision after a question.owner stop continues the card, with or without a pull request', () => {
    expect(continuesTheCard(turn({ owner_stop: 5 }), withinTheLimit)).toBe(true)
    expect(continuesTheCard(turn({ owner_stop: 5, pr: null }), withinTheLimit)).toBe(true)
  })

  it('past the round limit only a decision recorded after the last review continues the card', () => {
    expect(continuesTheCard(turn({ last_review: 9 }), pastTheLimit)).toBe(true)
    expect(continuesTheCard(turn({ last_review: 11 }), pastTheLimit)).toBe(false)
    expect(continuesTheCard(turn({ last_review: 9 }), withinTheLimit)).toBe(false)
    expect(continuesTheCard(turn({ pr: null }), pastTheLimit)).toBe(false)
  })

  it('the turn query reads the card through the fragments the queue passes', () => {
    const query = cardDecisionTurnQuery({ cardBody: card => `BODY(${card})`, latestTurn: card => `TURN(${card})`, notAWindowCard: card => `NOT_WINDOW(${card})`, downgradeWaitOpenOn: card => `WAIT(${card})` })
    expect(query).toContain('BODY(named.card_id) AS card_body')
    expect(query).toContain('stop.id = TURN(named.card_id)')
    expect(query).toContain('WHERE NOT_WINDOW(named.card_id) AND NOT WAIT(named.card_id)')
  })

  it('a card gets one continuation, and none while another answer of it is planned', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'card-decisions-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    const decided = [answerTask(CARD, 2), answerTask(CARD, 4), answerTask(OTHER_CARD, 3)]
    expect(oneContinuationPerCard(db, [], decided)).toEqual([answerTask(CARD, 2), answerTask(OTHER_CARD, 3)])
    expect(oneContinuationPerCard(db, [answerTask(OTHER_CARD)], decided)).toEqual([answerTask(CARD, 2)])
    db.close()
  })
})

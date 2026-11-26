import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { cardPrMerged } from '../../core/card-automaton.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_STOPPED, PR_OBSERVED, QUESTION_OWNER } from '../../core/events.js'
import { prOf } from '../../core/identifiers.js'
import { prFolds } from '../../core/pr-folds.js'
import { reduce } from '../../core/reducer.js'
import { recordDecision } from '../../policy/decisions/index.js'
import { isFullSha } from '../../ports/identifier-shapes.js'
import { busCardFolds, busProjections, decisionFoldsOfTheBus } from '../../supervisor/composition.js'

const LINKED_CARD = 7101
const STOPPED_CARD = 7102
const PR = 41
const HEAD = 'a'.repeat(40)
const DECISION = 9101

let db: DatabaseSync | null = null

afterEach(() => {
  db?.close()
  db = null
})

function observed(bus: DatabaseSync): void {
  appendEvent(bus, { ts: '2026-11-19T10:00:00.000Z', type: PR_OBSERVED, actor: 'netwatch', cardId: LINKED_CARD, pr: PR, head: HEAD, dedupeKey: `${PR_OBSERVED}:${PR}:${HEAD}`, payload: { base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, legacy: false })
}

function stoppedOnTheOwnerThenDecided(bus: DatabaseSync): void {
  appendEvent(bus, { ts: '2026-11-19T10:01:00.000Z', type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: STOPPED_CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${STOPPED_CARD}`, payload: { reason: QUESTION_OWNER, detail: 'may it?' }, legacy: false })
  recordDecision(bus, { ts: '2026-11-19T10:02:00.000Z', decisionId: DECISION, text: 'yes, it may', cards: [STOPPED_CARD] })
}

function cardOf(bus: DatabaseSync, cardId: number): { state: string | null, pr: number | null } | undefined {
  const row = bus.prepare('SELECT state, pr FROM cards WHERE card_id = ?').get(cardId) as { state: string | null, pr: number | null } | undefined
  return row === undefined ? undefined : { ...row }
}

describe('the card folds are sequenced by the composition, not written by the pr or decisions folds', () => {
  it('prFolds alone leaves the card unlinked on pr.observed', () => {
    db = openBus(':memory:')
    observed(db)
    const alone = prFolds({ transitions: { prMerged: cardPrMerged }, fields: { isFullSha, prOf }, cardOfBranch: () => null, closed: () => {} })
    expect(reduce(db, 'rebuild', { folds: [alone], incremental: [] })).toEqual({ applied: 1, rejected: 0 })
    expect(db.prepare('SELECT card_id FROM prs WHERE pr = ?').get(PR)).toEqual({ card_id: LINKED_CARD })
    expect(cardOf(db, LINKED_CARD)).toBeUndefined()
  })

  it('the decision folds alone leaves a QUESTION_OWNER stop unreleased', () => {
    db = openBus(':memory:')
    stoppedOnTheOwnerThenDecided(db)
    reduce(db, 'rebuild', { folds: [busCardFolds(), decisionFoldsOfTheBus()], incremental: [] })
    expect(db.prepare('SELECT decision_id FROM decisions').all().map(row => ({ ...row }))).toEqual([{ decision_id: DECISION }])
    expect(cardOf(db, STOPPED_CARD)?.state).toBe('stopped')
  })

  it('busProjections links the card and releases the stop', () => {
    db = openBus(':memory:')
    observed(db)
    stoppedOnTheOwnerThenDecided(db)
    reduce(db, 'rebuild', busProjections())
    expect(cardOf(db, LINKED_CARD)).toEqual({ state: 'in_review', pr: PR })
    expect(cardOf(db, STOPPED_CARD)?.state).toBe('queued')
  })
})

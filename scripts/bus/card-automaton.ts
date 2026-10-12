import type { DatabaseSync } from 'node:sqlite'
import type { Fold, StoredEvent } from './stored.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, QUESTION_OWNER } from './inbox.js'
import { CARD_ADMITTED, CARD_CLOSED } from './launch-candidates.js'
import { payloadOf, reject } from './stored.js'

export const PR_OPENED = 'pr.opened'
export const REVIEW_RECORDED = 'review.recorded'
export const MERGE_DONE = 'merge.done'
export const CARD_FELL = 'card.fell'

export const QUEUED_CARD = 'queued'
export const RUNNING_CARD = 'running'
export const IN_REVIEW_CARD = 'in_review'
export const CHANGES_CARD = 'changes'
export const READY_CARD = 'ready'
export const MERGED_CARD = 'merged'
export const CLOSED_CARD = 'closed'
export const FALLEN_CARD = 'fallen'
export const STOPPED_CARD = 'stopped'

type CardState = string | null

const STOP_REASONS = new Set(['question.agent', QUESTION_OWNER, 'review', 'conflict', 'fault', 'ci'])
const LINKED_INTO_REVIEW = new Set<CardState>([null, QUEUED_CARD, RUNNING_CARD, FALLEN_CARD])
const OPENS_A_PULL_REQUEST = new Set<CardState>([null, QUEUED_CARD, RUNNING_CARD])
const REVIEWED = new Set<CardState>([IN_REVIEW_CARD, CHANGES_CARD, READY_CARD])
const ADMITTED_AGAIN = new Set<CardState>([null, QUEUED_CARD, FALLEN_CARD, STOPPED_CARD, CLOSED_CARD])
const ANSWERED = new Set<CardState>([STOPPED_CARD, CHANGES_CARD, IN_REVIEW_CARD])
const FALLS = new Set<CardState>([RUNNING_CARD, IN_REVIEW_CARD, CHANGES_CARD])

interface Card {
  state: CardState
  pr: number | null
}

function cardOf(db: DatabaseSync, cardId: number): Card | undefined {
  return db.prepare('SELECT state, pr FROM cards WHERE card_id = ?').get(cardId) as Card | undefined
}

function stateOf(db: DatabaseSync, cardId: number): CardState {
  return cardOf(db, cardId)?.state ?? null
}

function linkedPrState(db: DatabaseSync, cardId: number): string | null {
  const row = db.prepare('SELECT prs.state FROM cards JOIN prs ON prs.pr = cards.pr WHERE cards.card_id = ?').get(cardId) as { state: string | null } | undefined
  return row?.state ?? null
}

function moveCard(db: DatabaseSync, cardId: number, state: string, eventId: number): void {
  db.prepare(`
    INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, ?)
    ON CONFLICT (card_id) DO UPDATE SET state = excluded.state, event_id = excluded.event_id
  `).run(cardId, state, eventId)
}

function claimed(db: DatabaseSync, event: StoredEvent, from: Set<CardState>, to: string): void {
  const cardId = event.card_id ?? reject(`${event.type} needs a card_id`)
  const state = stateOf(db, cardId)
  if (!from.has(state))
    reject(`card ${cardId} is ${state ?? 'without state'}, and ${event.type} moves only a card that is ${[...from].map(each => each ?? 'without state').join(' | ')}`)
  moveCard(db, cardId, to, event.id)
}

export function cardLinkObserved(db: DatabaseSync, cardId: number, eventId: number): void {
  if (LINKED_INTO_REVIEW.has(stateOf(db, cardId)))
    moveCard(db, cardId, IN_REVIEW_CARD, eventId)
}

export function cardPrMerged(db: DatabaseSync, cardId: number, eventId: number): void {
  if (stateOf(db, cardId) !== CLOSED_CARD)
    moveCard(db, cardId, MERGED_CARD, eventId)
}

export function cardPrOpened(db: DatabaseSync, cardId: number, pr: number, linkedBefore: number | null, eventId: number): void {
  const state = stateOf(db, cardId)
  if (linkedBefore === pr && state === IN_REVIEW_CARD)
    return
  const relinked = linkedBefore !== null && linkedBefore !== pr
  if (!relinked && !OPENS_A_PULL_REQUEST.has(state))
    reject(`card ${cardId} is ${state}, and ${PR_OPENED} moves only a card that is queued, running or without state`)
  moveCard(db, cardId, IN_REVIEW_CARD, eventId)
}

function foldAdmitted(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_ADMITTED} needs a card_id`)
  if (ADMITTED_AGAIN.has(stateOf(db, cardId)))
    moveCard(db, cardId, QUEUED_CARD, event.id)
}

function foldReviewRecorded(db: DatabaseSync, event: StoredEvent): void {
  if (event.card_id === null || !REVIEWED.has(stateOf(db, event.card_id)))
    return
  moveCard(db, event.card_id, payloadOf(event).verdict === 'pass' ? READY_CARD : CHANGES_CARD, event.id)
}

function foldMergeDone(db: DatabaseSync, event: StoredEvent): void {
  if (event.card_id !== null)
    cardPrMerged(db, event.card_id, event.id)
}

function foldStarted(db: DatabaseSync, event: StoredEvent): void {
  claimed(db, event, new Set([QUEUED_CARD]), RUNNING_CARD)
}

function foldAnswered(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_ANSWERED} needs a card_id`)
  claimed(db, event, ANSWERED, linkedPrState(db, cardId) === 'open' ? IN_REVIEW_CARD : QUEUED_CARD)
}

function foldClosed(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_CLOSED} needs a card_id`)
  if (stateOf(db, cardId) !== MERGED_CARD && linkedPrState(db, cardId) !== 'merged')
    reject(`card ${cardId} is ${stateOf(db, cardId) ?? 'without state'} and its pull request is not merged, and ${CARD_CLOSED} closes only a merged card`)
  moveCard(db, cardId, CLOSED_CARD, event.id)
}

function foldFell(db: DatabaseSync, event: StoredEvent): void {
  claimed(db, event, FALLS, FALLEN_CARD)
}

function foldStopped(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_STOPPED} needs a card_id`)
  const reason = payloadOf(event).reason
  if (typeof reason !== 'string' || !STOP_REASONS.has(reason))
    reject(`reason is not one of ${[...STOP_REASONS].join(' | ')}`)
  if (stateOf(db, cardId) === CLOSED_CARD)
    reject(`card ${cardId} is ${CLOSED_CARD}, and ${CARD_STOPPED} stops no closed card`)
  moveCard(db, cardId, STOPPED_CARD, event.id)
}

export const CARD_FOLDED_ON_APPEND: readonly string[] = [REVIEW_RECORDED, MERGE_DONE, CARD_STOPPED]

export const CARD_FOLDS: Record<string, Fold> = {
  [CARD_ADMITTED]: foldAdmitted,
  [CARD_STARTED]: foldStarted,
  [CARD_STOPPED]: foldStopped,
  [CARD_ANSWERED]: foldAnswered,
  [REVIEW_RECORDED]: foldReviewRecorded,
  [MERGE_DONE]: foldMergeDone,
  [CARD_CLOSED]: foldClosed,
  [CARD_FELL]: foldFell,
}

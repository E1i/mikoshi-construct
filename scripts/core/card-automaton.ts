import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Fold, StoredEvent } from './stored.js'
import type { IncrementalProjection } from './watermark.js'
import { isBackfill } from './backfill-source.js'
import { appendEvent } from './db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_CLOSED, CARD_DROPPED, CARD_FELL, CARD_MOVED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, DROPPED_LANE, MERGE_DONE, PR_OPENED, QUESTION_OWNER, REVIEW_RECORDED, TERMINAL_LANES, WITNESS_RECORDED } from './events.js'
import { legacyHistory } from './legacy-history.js'
import { payloadOf, reject, STORED_COLUMNS } from './stored.js'
import { markReduced, reduceProjection, watermarkOf } from './watermark.js'

export const QUEUED_CARD = 'queued'
export const RUNNING_CARD = 'running'
export const IN_REVIEW_CARD = 'in_review'
export const CHANGES_CARD = 'changes'
export const READY_CARD = 'ready'
export const MERGED_CARD = 'merged'
export const CLOSED_CARD = 'closed'
export const FALLEN_CARD = 'fallen'
export const STOPPED_CARD = 'stopped'
export const DROPPED_CARD = 'dropped'

export { DROPPED_LANE }

type CardState = string | null

const STOP_REASONS = new Set(['question.agent', QUESTION_OWNER, 'review', 'conflict', 'fault', 'ci'])
const LINKED_INTO_REVIEW = new Set<CardState>([null, QUEUED_CARD, RUNNING_CARD, FALLEN_CARD])
const OPENS_A_PULL_REQUEST = new Set<CardState>([null, QUEUED_CARD, RUNNING_CARD])
const REVIEWED = new Set<CardState>([IN_REVIEW_CARD, CHANGES_CARD, READY_CARD])
const ADMITTED_AGAIN = new Set<CardState>([null, QUEUED_CARD, FALLEN_CARD, STOPPED_CARD, CLOSED_CARD, DROPPED_CARD])
const ANSWERED = new Set<CardState>([STOPPED_CARD, CHANGES_CARD, IN_REVIEW_CARD])
const FALLS = new Set<CardState>([RUNNING_CARD, IN_REVIEW_CARD, CHANGES_CARD])
const ENDED = new Set<CardState>([MERGED_CARD, CLOSED_CARD, DROPPED_CARD])
const FAULT = 'fault'
const LEASED_TASK = 'leased'

const LAST_STOP_REASON = `
  SELECT json_extract(payload, '$.reason') AS reason FROM events
  WHERE legacy = 0 AND type = '${CARD_STOPPED}' AND card_id = ? AND id < ?
  ORDER BY id DESC LIMIT 1
`

const SHARED_BY_A_DECISION = `SELECT 1 FROM events WHERE type = ? AND legacy = 0 AND card_id = ? AND pr = ? AND json_valid(payload) AND json_type(payload, '$.sharedBy') = 'text' LIMIT 1`

const CURRENT_LAUNCH_LEASE = `SELECT task_key, state, lease_gen FROM tasks WHERE queue = 'launch' AND card_id = ? ORDER BY event_id DESC LIMIT 1`

interface LaunchLease {
  task_key: string
  state: string
  lease_gen: number
}

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

function stoppedByFault(db: DatabaseSync, cardId: number, before: number): boolean {
  if (stateOf(db, cardId) !== STOPPED_CARD)
    return false
  const row = db.prepare(LAST_STOP_REASON).get(cardId, before) as { reason: unknown } | undefined
  return row?.reason === FAULT
}

function leaseGenCarriedBy(event: StoredEvent, current: LaunchLease | undefined): number | null {
  const carried = payloadOf(event).lease_gen
  if (typeof carried === 'number' && Number.isSafeInteger(carried) && carried > 0)
    return carried
  return current?.state === LEASED_TASK && event.dedupe_key === `${CARD_STARTED}:${current.task_key}` ? current.lease_gen : null
}

function restoreFromFault(db: DatabaseSync, event: StoredEvent, cardId: number): void {
  const current = db.prepare(CURRENT_LAUNCH_LEASE).get(cardId) as LaunchLease | undefined
  const carried = leaseGenCarriedBy(event, current)
  if (carried === null || carried !== current?.lease_gen)
    reject(`card ${cardId} is ${STOPPED_CARD} by ${FAULT}, and ${event.type} restores it only under the current lease_gen ${current?.lease_gen ?? 'of no launch'} of its launch, not ${carried ?? 'none'}`)
}

function storedById(db: DatabaseSync, eventId: number): StoredEvent {
  return db.prepare(`SELECT ${STORED_COLUMNS} FROM events WHERE id = ?`).get(eventId) as unknown as StoredEvent
}

export function cardPrOpened(db: DatabaseSync, cardId: number, pr: number, linkedBefore: number | null, eventId: number): void {
  const state = stateOf(db, cardId)
  if (linkedBefore === pr && state === IN_REVIEW_CARD)
    return
  const relinked = linkedBefore !== null && linkedBefore !== pr
  if (!relinked && stoppedByFault(db, cardId, eventId))
    restoreFromFault(db, storedById(db, eventId), cardId)
  else if (!relinked && !OPENS_A_PULL_REQUEST.has(state))
    reject(`card ${cardId} is ${state}, and ${PR_OPENED} moves only a card that is queued, running or without state`)
  moveCard(db, cardId, IN_REVIEW_CARD, eventId)
}

function mergedInTheJournalBefore(db: DatabaseSync, cardId: number, before: number): boolean {
  return db.prepare(`SELECT 1 FROM events WHERE legacy = 1 AND type = 'merge' AND card_id = ? AND id < ? LIMIT 1`).get(cardId, before) !== undefined
}

function foldAdmitted(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_ADMITTED} needs a card_id`)
  if (isBackfill(payloadOf(event)) || !ADMITTED_AGAIN.has(stateOf(db, cardId)))
    return
  moveCard(db, cardId, mergedInTheJournalBefore(db, cardId, event.id) ? MERGED_CARD : QUEUED_CARD, event.id)
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
  const cardId = event.card_id ?? reject(`${CARD_STARTED} needs a card_id`)
  if (!stoppedByFault(db, cardId, event.id)) {
    claimed(db, event, new Set([QUEUED_CARD]), RUNNING_CARD)
    return
  }
  restoreFromFault(db, event, cardId)
  moveCard(db, cardId, RUNNING_CARD, event.id)
}

function backInWork(db: DatabaseSync, cardId: number): string {
  return linkedPrState(db, cardId) === 'open' ? IN_REVIEW_CARD : QUEUED_CARD
}

export function cardReleased(db: DatabaseSync, cardId: number, eventId: number): void {
  moveCard(db, cardId, backInWork(db, cardId), eventId)
}

function foldAnswered(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_ANSWERED} needs a card_id`)
  claimed(db, event, ANSWERED, backInWork(db, cardId))
}

const CLOSED_BY_REPORT = `type = '${CARD_VERIFIED}' AND legacy = 0 AND pr IS NULL AND card_id IS NOT NULL AND json_extract(payload, '$.report') IS NOT NULL`

const GREEN_VERDICT = 'green'

const LATEST_WITNESS_ON_MAIN = `SELECT json_extract(payload, '$.verdict') AS verdict FROM events WHERE type = '${WITNESS_RECORDED}' AND legacy = 0 AND card_id = ? AND pr IS NULL ORDER BY id DESC LIMIT 1`

function closedByReport(db: DatabaseSync, cardId: number): boolean {
  return db.prepare(`SELECT 1 FROM events WHERE ${CLOSED_BY_REPORT} AND card_id = ? LIMIT 1`).get(cardId) !== undefined
}

function witnessedOnMain(db: DatabaseSync, cardId: number): boolean {
  const latest = db.prepare(LATEST_WITNESS_ON_MAIN).get(cardId) as { verdict: unknown } | undefined
  return latest?.verdict === GREEN_VERDICT
}

const SATISFIED_IN_THE_BUS = `
  SELECT card_id FROM cards WHERE state IN ('${MERGED_CARD}', '${CLOSED_CARD}')
  UNION SELECT card_id FROM prs WHERE state = 'merged' AND card_id IS NOT NULL
  UNION SELECT card_id FROM events WHERE ${CLOSED_BY_REPORT}
`

function satisfiedInTheBus(db: DatabaseSync): Set<number> {
  return new Set((db.prepare(SATISFIED_IN_THE_BUS).all() as { card_id: number }[]).map(row => Number(row.card_id)))
}

type JournalLine = ReturnType<typeof legacyHistory>[number]

function satisfiedInTheJournal(history: readonly JournalLine[]): Set<number> {
  const probeClosedByReport = (entry: JournalLine): boolean => entry.event === 'path' && typeof entry.verification === 'string' && typeof entry.report === 'string' && entry.pr === undefined
  return new Set(history.filter(entry => typeof entry.task === 'string' && (entry.event === 'merge' || probeClosedByReport(entry))).map(entry => Number(entry.task)))
}

export type UnsatisfiedDependencies = (depends: readonly number[]) => number[]

export function unsatisfiedDependencies(db: DatabaseSync): UnsatisfiedDependencies {
  let inTheBus: Set<number> | undefined
  let inTheJournal: Set<number> | undefined
  return (depends) => {
    if (depends.length === 0)
      return []
    inTheBus ??= satisfiedInTheBus(db)
    const open = depends.filter(dependency => !inTheBus!.has(dependency))
    if (open.length === 0)
      return []
    inTheJournal ??= satisfiedInTheJournal(legacyHistory(db))
    return open.filter(dependency => !inTheJournal!.has(dependency))
  }
}

function sharedByADecision(db: DatabaseSync, cardId: number, pr: number | null): boolean {
  if (pr === null)
    return false
  const merged = db.prepare(`SELECT 1 FROM prs WHERE pr = ? AND state = 'merged'`).get(pr) !== undefined
  return merged && db.prepare(SHARED_BY_A_DECISION).get(CARD_VERIFIED, cardId, pr) !== undefined
}

function foldClosed(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_CLOSED} needs a card_id`)
  if (stateOf(db, cardId) !== MERGED_CARD && linkedPrState(db, cardId) !== 'merged' && !(event.pr === null && (closedByReport(db, cardId) || witnessedOnMain(db, cardId))) && !sharedByADecision(db, cardId, event.pr))
    reject(`card ${cardId} is ${stateOf(db, cardId) ?? 'without state'} and its pull request is not merged, and ${CARD_CLOSED} closes only a merged card`)
  moveCard(db, cardId, CLOSED_CARD, event.id)
}

function foldFell(db: DatabaseSync, event: StoredEvent): void {
  if (event.card_id !== null && stateOf(db, event.card_id) === DROPPED_CARD)
    return
  claimed(db, event, FALLS, FALLEN_CARD)
}

function foldMoved(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_MOVED} needs a card_id`)
  const lane = payloadOf(event).lane
  if (typeof lane === 'string' && TERMINAL_LANES.has(lane) && !ENDED.has(stateOf(db, cardId)))
    moveCard(db, cardId, DROPPED_CARD, event.id)
}

function foldDropped(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_DROPPED} needs a card_id`)
  if (!ENDED.has(stateOf(db, cardId)))
    moveCard(db, cardId, DROPPED_CARD, event.id)
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

const CARD_ON_APPEND_FOLDS: Record<string, Fold> = {
  [REVIEW_RECORDED]: foldReviewRecorded,
  [MERGE_DONE]: foldMergeDone,
  [CARD_STOPPED]: foldStopped,
}

export const CARD_FOLDED_ON_APPEND: readonly string[] = Object.keys(CARD_ON_APPEND_FOLDS)

export const CARDS_PROJECTION: IncrementalProjection = { table: 'cards', folds: CARD_ON_APPEND_FOLDS }

export const CARD_FOLDS: Record<string, Fold> = {
  ...CARD_ON_APPEND_FOLDS,
  [CARD_ADMITTED]: foldAdmitted,
  [CARD_STARTED]: foldStarted,
  [CARD_ANSWERED]: foldAnswered,
  [CARD_CLOSED]: foldClosed,
  [CARD_FELL]: foldFell,
  [CARD_MOVED]: foldMoved,
  [CARD_DROPPED]: foldDropped,
}

function lastEventId(db: DatabaseSync): number {
  return Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id)
}

export function appendedOnCard(db: DatabaseSync, event: BusEvent): boolean {
  const current = lastEventId(db)
  const appended = appendEvent(db, event)
  if (watermarkOf(db, CARDS_PROJECTION.table) === 0)
    markReduced(db, CARDS_PROJECTION.table, current)
  reduceProjection(db, CARDS_PROJECTION)
  return appended
}

import type { DatabaseSync } from 'node:sqlite'
import type { BusContract, BusEventDraft, BusEventRow, BusProjection } from '../ports/bus-contract.js'
import type { Fold, StoredEvent } from './stored-event.js'
import { isBackfill } from './backfill-source.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_CLOSED, CARD_DEFERRED, CARD_DROPPED, CARD_FELL, CARD_MOVED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, DROPPED_LANE, MERGE_DONE, PR_OPENED, QUESTION_OWNER, REVIEW_RECORDED, TERMINAL_LANES, WITNESS_RECORDED } from './events.js'
import { reject } from './stored-event.js'

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
export const DEFERRED_CARD = 'deferred'

export const NOT_MINE = 'not_mine'

const NOT_THE_BUS_CARD_STATES: ReadonlySet<string | null> = new Set([CLOSED_CARD, DROPPED_CARD])

export function notMine(card: { id: number, state: string | null } | null, command: string): string | null {
  if (card === null || !NOT_THE_BUS_CARD_STATES.has(card.state))
    return null
  return `card #${card.id} is ${card.state} in the bus, so no ${command} of it is the bus's to run`
}

export { DROPPED_LANE }

type CardState = string | null

const STOP_REASONS = new Set(['question.agent', QUESTION_OWNER, 'review', 'conflict', 'fault', 'ci'])
const LINKED_INTO_REVIEW = new Set<CardState>([null, QUEUED_CARD, RUNNING_CARD, FALLEN_CARD, DEFERRED_CARD])
const OPENS_A_PULL_REQUEST = new Set<CardState>([null, QUEUED_CARD, RUNNING_CARD, DEFERRED_CARD])
const REVIEWED = new Set<CardState>([IN_REVIEW_CARD, CHANGES_CARD, READY_CARD])
const ADMITTED_AGAIN = new Set<CardState>([null, QUEUED_CARD, FALLEN_CARD, STOPPED_CARD, CLOSED_CARD, DROPPED_CARD])
const ANSWERED = new Set<CardState>([STOPPED_CARD, CHANGES_CARD, IN_REVIEW_CARD])
const FALLS = new Set<CardState>([RUNNING_CARD, IN_REVIEW_CARD, CHANGES_CARD])
const ENDED = new Set<CardState>([MERGED_CARD, CLOSED_CARD, DROPPED_CARD])
const NOT_IN_WORK = new Set<CardState>([DROPPED_CARD, DEFERRED_CARD])
const FAULT = 'fault'
const LEASED_TASK = 'leased'
const JOURNAL_MERGE = 'merge'

function lastStopReason(bus: BusContract, db: DatabaseSync, cardId: number, before: number): unknown {
  return bus.latest(db, { types: [CARD_STOPPED], card: cardId, before })?.data?.reason
}

function sharedByADecisionRecorded(bus: BusContract, db: DatabaseSync, cardId: number, pr: number): boolean {
  return bus.events(db, { types: [CARD_VERIFIED], card: cardId, pr }).some(event => typeof event.data?.sharedBy === 'string')
}

const LAUNCH_QUEUE = 'launch'

interface LaunchLease {
  task_key: string
  state: string
  lease_gen: number
}

function currentLaunchLease(bus: BusContract, db: DatabaseSync, cardId: number): LaunchLease | undefined {
  return bus.tasksOfCard(db, cardId, { queue: LAUNCH_QUEUE }).at(-1)
}

export interface CardPrReadings {
  stateOf: (db: DatabaseSync, pr: number) => string | null
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

function linkedPrState(db: DatabaseSync, cardId: number, prs: CardPrReadings): string | null {
  const pr = cardOf(db, cardId)?.pr ?? null
  return pr === null ? null : prs.stateOf(db, pr)
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

function linkCard(db: DatabaseSync, cardId: number, pr: number, refusal: string | null, eventId: number): void {
  if (cardOf(db, cardId)?.pr === pr)
    return
  if (refusal !== null)
    reject(refusal)
  db.prepare(`
    INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, NULL, ?, ?)
    ON CONFLICT (card_id) DO UPDATE SET pr = excluded.pr, event_id = excluded.event_id
  `).run(cardId, pr, eventId)
}

export function cardLinkObserved(db: DatabaseSync, cardId: number, pr: number, refusal: string | null, eventId: number): void {
  linkCard(db, cardId, pr, refusal, eventId)
  if (LINKED_INTO_REVIEW.has(stateOf(db, cardId)))
    moveCard(db, cardId, IN_REVIEW_CARD, eventId)
}

export function cardPrMerged(db: DatabaseSync, cardId: number, eventId: number): void {
  if (stateOf(db, cardId) !== CLOSED_CARD)
    moveCard(db, cardId, MERGED_CARD, eventId)
}

function stoppedByFault(bus: BusContract, db: DatabaseSync, cardId: number, before: number): boolean {
  if (stateOf(db, cardId) !== STOPPED_CARD)
    return false
  return lastStopReason(bus, db, cardId, before) === FAULT
}

const FIRST_LEASE_GEN = 1

export function launchStartKey(taskKey: string, leaseGen: number): string {
  return leaseGen === FIRST_LEASE_GEN ? `${CARD_STARTED}:${taskKey}` : `${CARD_STARTED}:${taskKey}:${leaseGen}`
}

export function launchStartLease(leaseGen: number): { lease_gen?: number } {
  return leaseGen === FIRST_LEASE_GEN ? {} : { lease_gen: leaseGen }
}

function leaseGenCarriedBy(bus: BusContract, event: StoredEvent, current: LaunchLease | undefined): number | null {
  const carried = bus.payloadOf(event).lease_gen
  if (typeof carried === 'number' && Number.isSafeInteger(carried) && carried > 0)
    return carried
  return current?.state === LEASED_TASK && event.dedupe_key === launchStartKey(current.task_key, current.lease_gen) ? current.lease_gen : null
}

function restoreFromFault(bus: BusContract, db: DatabaseSync, event: StoredEvent, cardId: number): void {
  const current = currentLaunchLease(bus, db, cardId)
  const carried = leaseGenCarriedBy(bus, event, current)
  if (carried === null || carried !== current?.lease_gen)
    reject(`card ${cardId} is ${STOPPED_CARD} by ${FAULT}, and ${event.type} restores it only under the current lease_gen ${current?.lease_gen ?? 'of no launch'} of its launch, not ${carried ?? 'none'}`)
}

function storedById(bus: BusContract, db: DatabaseSync, eventId: number): StoredEvent {
  return bus.byId(db, eventId) ?? reject(`event ${eventId} is not in the bus`)
}

export function cardPrOpened(bus: BusContract, db: DatabaseSync, cardId: number, pr: number, refusal: string | null, eventId: number): void {
  const linkedBefore = cardOf(db, cardId)?.pr ?? null
  linkCard(db, cardId, pr, refusal, eventId)
  const state = stateOf(db, cardId)
  if (linkedBefore === pr && state === IN_REVIEW_CARD)
    return
  const relinked = linkedBefore !== null && linkedBefore !== pr
  if (!relinked && stoppedByFault(bus, db, cardId, eventId))
    restoreFromFault(bus, db, storedById(bus, db, eventId), cardId)
  else if (!relinked && !OPENS_A_PULL_REQUEST.has(state))
    reject(`card ${cardId} is ${state}, and ${PR_OPENED} moves only a card that is queued, running or without state`)
  moveCard(db, cardId, IN_REVIEW_CARD, eventId)
}

function mergedInTheJournalBefore(bus: BusContract, db: DatabaseSync, cardId: number, before: number): boolean {
  return bus.latest(db, { types: [JOURNAL_MERGE], card: cardId, before, legacy: true }) !== null
}

function foldAdmitted(bus: BusContract, db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_ADMITTED} needs a card_id`)
  if (isBackfill(bus.payloadOf(event)) || !ADMITTED_AGAIN.has(stateOf(db, cardId)))
    return
  moveCard(db, cardId, mergedInTheJournalBefore(bus, db, cardId, event.id) ? MERGED_CARD : QUEUED_CARD, event.id)
}

function foldReviewRecorded(bus: BusContract, db: DatabaseSync, event: StoredEvent): void {
  if (event.card_id === null || !REVIEWED.has(stateOf(db, event.card_id)))
    return
  moveCard(db, event.card_id, bus.payloadOf(event).verdict === 'pass' ? READY_CARD : CHANGES_CARD, event.id)
}

function foldMergeDone(db: DatabaseSync, event: StoredEvent): void {
  if (event.card_id !== null)
    cardPrMerged(db, event.card_id, event.id)
}

function foldStarted(bus: BusContract, db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_STARTED} needs a card_id`)
  if (!stoppedByFault(bus, db, cardId, event.id)) {
    claimed(db, event, new Set([QUEUED_CARD]), RUNNING_CARD)
    return
  }
  restoreFromFault(bus, db, event, cardId)
  moveCard(db, cardId, RUNNING_CARD, event.id)
}

function backInWork(db: DatabaseSync, cardId: number, prs: CardPrReadings): string {
  return linkedPrState(db, cardId, prs) === 'open' ? IN_REVIEW_CARD : QUEUED_CARD
}

function cardReleased(db: DatabaseSync, cardId: number, eventId: number, prs: CardPrReadings): void {
  moveCard(db, cardId, backInWork(db, cardId, prs), eventId)
}

function stoppedOnAnOwnerQuestion(bus: BusContract, db: DatabaseSync, cardId: number, before: number): boolean {
  if (stateOf(db, cardId) !== STOPPED_CARD)
    return false
  return lastStopReason(bus, db, cardId, before) === QUESTION_OWNER
}

function aWaitItDidNotNameStaysOpen(bus: BusContract, db: DatabaseSync, cardId: number, named: readonly string[]): boolean {
  return named.length > 0 && db.prepare(`SELECT 1 FROM owner_waits WHERE state = ? AND card_id = ? AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`).get(bus.openWait, cardId, JSON.stringify(named)) !== undefined
}

export function cardsAnswered(bus: BusContract, db: DatabaseSync, cards: readonly number[], named: readonly string[], eventId: number, prs: CardPrReadings): void {
  for (const cardId of cards) {
    if (stoppedOnAnOwnerQuestion(bus, db, cardId, eventId) && !aWaitItDidNotNameStaysOpen(bus, db, cardId, named))
      cardReleased(db, cardId, eventId, prs)
  }
}

function foldAnswered(db: DatabaseSync, event: StoredEvent, prs: CardPrReadings): void {
  const cardId = event.card_id ?? reject(`${CARD_ANSWERED} needs a card_id`)
  const readmittedWithItsPullRequestOpen = stateOf(db, cardId) === QUEUED_CARD && linkedPrState(db, cardId, prs) === 'open'
  claimed(db, event, readmittedWithItsPullRequestOpen ? new Set([QUEUED_CARD]) : ANSWERED, backInWork(db, cardId, prs))
}

const GREEN_VERDICT = 'green'
const MERGED_PR = 'merged'

function reportsAClose(event: BusEventRow): boolean {
  const report = event.data?.report
  return report !== undefined && report !== null
}

function closedByReport(bus: BusContract, db: DatabaseSync, cardId: number): boolean {
  return bus.events(db, { types: [CARD_VERIFIED], card: cardId, pr: null }).some(reportsAClose)
}

function witnessedOnMain(bus: BusContract, db: DatabaseSync, cardId: number): boolean {
  return bus.latest(db, { types: [WITNESS_RECORDED], card: cardId, pr: null })?.data?.verdict === GREEN_VERDICT
}

const SATISFIED_IN_THE_BUS = `SELECT card_id FROM cards WHERE state IN ('${MERGED_CARD}', '${CLOSED_CARD}')`

function closedByReportPerCard(bus: BusContract, db: DatabaseSync): number[] {
  return [...bus.perCard(db, { types: [CARD_VERIFIED], pr: null })].filter(([, verified]) => verified.some(reportsAClose)).map(([cardId]) => cardId)
}

interface PullRequestValue {
  card_id: number | null
  state: string | null
}

interface JournalLine {
  event?: unknown
  task?: unknown
  verification?: unknown
  report?: unknown
  pr?: unknown
}

export interface DependencyReadings {
  pullRequests: () => readonly PullRequestValue[]
  journal: () => readonly JournalLine[]
}

function mergedPullRequestCards(pullRequests: readonly PullRequestValue[]): number[] {
  return pullRequests.flatMap(pr => pr.state === MERGED_PR && pr.card_id !== null ? [pr.card_id] : [])
}

function satisfiedInTheBus(bus: BusContract, db: DatabaseSync, readings: DependencyReadings): Set<number> {
  return new Set([...(db.prepare(SATISFIED_IN_THE_BUS).all() as { card_id: number }[]).map(row => Number(row.card_id)), ...mergedPullRequestCards(readings.pullRequests()), ...closedByReportPerCard(bus, db)])
}

function satisfiedInTheJournal(history: readonly JournalLine[]): Set<number> {
  const probeClosedByReport = (entry: JournalLine): boolean => entry.event === 'path' && typeof entry.verification === 'string' && typeof entry.report === 'string' && entry.pr === undefined
  return new Set(history.filter(entry => typeof entry.task === 'string' && (entry.event === 'merge' || probeClosedByReport(entry))).map(entry => Number(entry.task)))
}

export type UnsatisfiedDependencies = (depends: readonly number[]) => number[]

export function unsatisfiedDependencies(bus: BusContract, db: DatabaseSync, readings: DependencyReadings): UnsatisfiedDependencies {
  let inTheBus: Set<number> | undefined
  let inTheJournal: Set<number> | undefined
  return (depends) => {
    if (depends.length === 0)
      return []
    inTheBus ??= satisfiedInTheBus(bus, db, readings)
    const open = depends.filter(dependency => !inTheBus!.has(dependency))
    if (open.length === 0)
      return []
    inTheJournal ??= satisfiedInTheJournal(readings.journal())
    return open.filter(dependency => !inTheJournal!.has(dependency))
  }
}

function sharedByADecision(bus: BusContract, db: DatabaseSync, cardId: number, pr: number | null, prs: CardPrReadings): boolean {
  if (pr === null)
    return false
  return prs.stateOf(db, pr) === MERGED_PR && sharedByADecisionRecorded(bus, db, cardId, pr)
}

function foldClosed(bus: BusContract, db: DatabaseSync, event: StoredEvent, prs: CardPrReadings): void {
  const cardId = event.card_id ?? reject(`${CARD_CLOSED} needs a card_id`)
  if (stateOf(db, cardId) !== MERGED_CARD && linkedPrState(db, cardId, prs) !== MERGED_PR && !(event.pr === null && (closedByReport(bus, db, cardId) || witnessedOnMain(bus, db, cardId))) && !sharedByADecision(bus, db, cardId, event.pr, prs))
    reject(`card ${cardId} is ${stateOf(db, cardId) ?? 'without state'} and its pull request is not merged, and ${CARD_CLOSED} closes only a merged card`)
  moveCard(db, cardId, CLOSED_CARD, event.id)
}

function foldFell(db: DatabaseSync, event: StoredEvent): void {
  if (event.card_id !== null && NOT_IN_WORK.has(stateOf(db, event.card_id)))
    return
  claimed(db, event, FALLS, FALLEN_CARD)
}

function foldMoved(bus: BusContract, db: DatabaseSync, event: StoredEvent, prs: CardPrReadings): void {
  const cardId = event.card_id ?? reject(`${CARD_MOVED} needs a card_id`)
  const lane = bus.payloadOf(event).lane
  if (typeof lane === 'string' && TERMINAL_LANES.has(lane) && !ENDED.has(stateOf(db, cardId)))
    moveCard(db, cardId, DROPPED_CARD, event.id)
  else if (stateOf(db, cardId) === DEFERRED_CARD)
    moveCard(db, cardId, backInWork(db, cardId, prs), event.id)
}

function foldDeferred(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_DEFERRED} needs a card_id`)
  if (!ENDED.has(stateOf(db, cardId)))
    moveCard(db, cardId, DEFERRED_CARD, event.id)
}

function foldDropped(db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_DROPPED} needs a card_id`)
  if (!ENDED.has(stateOf(db, cardId)))
    moveCard(db, cardId, DROPPED_CARD, event.id)
}

function foldStopped(bus: BusContract, db: DatabaseSync, event: StoredEvent): void {
  const cardId = event.card_id ?? reject(`${CARD_STOPPED} needs a card_id`)
  const reason = bus.payloadOf(event).reason
  if (typeof reason !== 'string' || !STOP_REASONS.has(reason))
    reject(`reason is not one of ${[...STOP_REASONS].join(' | ')}`)
  if (stateOf(db, cardId) === CLOSED_CARD)
    reject(`card ${cardId} is ${CLOSED_CARD}, and ${CARD_STOPPED} stops no closed card`)
  moveCard(db, cardId, STOPPED_CARD, event.id)
}

function cardOnAppendFolds(bus: BusContract): Record<string, Fold> {
  return {
    [REVIEW_RECORDED]: (db, event) => foldReviewRecorded(bus, db, event),
    [MERGE_DONE]: foldMergeDone,
    [CARD_STOPPED]: (db, event) => foldStopped(bus, db, event),
  }
}

export const CARD_FOLDED_ON_APPEND: readonly string[] = [REVIEW_RECORDED, MERGE_DONE, CARD_STOPPED]

const CARDS_TABLE = 'cards'

export function cardsProjection(bus: BusContract): BusProjection {
  return { table: CARDS_TABLE, folds: cardOnAppendFolds(bus) }
}

export function cardFolds(bus: BusContract, prs: CardPrReadings): Record<string, Fold> {
  return {
    ...cardOnAppendFolds(bus),
    [CARD_ADMITTED]: (db, event) => foldAdmitted(bus, db, event),
    [CARD_STARTED]: (db, event) => foldStarted(bus, db, event),
    [CARD_FELL]: foldFell,
    [CARD_DEFERRED]: foldDeferred,
    [CARD_DROPPED]: foldDropped,
    [CARD_ANSWERED]: (db, event) => foldAnswered(db, event, prs),
    [CARD_CLOSED]: (db, event) => foldClosed(bus, db, event, prs),
    [CARD_MOVED]: (db, event) => foldMoved(bus, db, event, prs),
  }
}

export function appendedOnCard(bus: BusContract, db: DatabaseSync, event: BusEventDraft): boolean {
  const projection = cardsProjection(bus)
  const current = bus.lastEventId(db)
  const appended = bus.appendEvent(db, event)
  if (bus.watermarkOf(db, projection.table) === 0)
    bus.markReduced(db, projection.table, current)
  bus.reduceProjection(db, projection)
  return appended
}

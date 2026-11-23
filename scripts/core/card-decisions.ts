import type { DatabaseSync } from 'node:sqlite'
import type { BoundDecision, Queue } from './identifiers.js'
import type { QueuedTask } from './queue.js'
import { existsSync } from 'node:fs'
import { BUSY_TIMEOUT_MS } from './db.js'
import { CARD_STOPPED, DECISION_RECORDED, QUESTION_AGENT, QUESTION_OWNER, REVIEW_RECORDED } from './events.js'
import { A_CARD_DECISION_REOPENS, latestCardDecision } from './identifiers.js'
import { openDatabase } from './sqlite.js'

export const CARD_DECISIONS_HEADING = 'Owner decisions in force for this card. They are the owner\'s answer: follow them, and do not ask the owner again what they settle.'

const ENDED_WITHOUT_RUNNING: readonly string[] = ['superseded', 'withdrawn']
const LIVE_ANSWER_STATES: readonly string[] = ['queued', 'leased']

export type CardDecisionLines = (db: DatabaseSync, cardId: number, now: Date) => string[]

export function cardDecisionBlock(decisions: readonly string[]): string[] {
  return decisions.length === 0 ? [] : [CARD_DECISIONS_HEADING, ...decisions]
}

export function withCardDecisions<Task extends { body: string }>(task: Task, decisions: readonly string[]): Task {
  const block = cardDecisionBlock(decisions)
  return block.length === 0 ? task : { ...task, body: `${task.body}\n\n${block.join('\n')}` }
}

export function busCardDecisions(busPath: string, linesOf: CardDecisionLines, now: () => Date = () => new Date()): (cardId: number) => string[] {
  return (cardId) => {
    if (!existsSync(busPath))
      return []
    const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    try {
      return linesOf(db, cardId, now())
    }
    finally {
      db.close()
    }
  }
}

interface RecordedReview {
  id?: unknown
  verdict: unknown
}

export interface CardDecisionReads {
  decisions: readonly BoundDecision[]
  decidedAt: (decisionId: number) => number | undefined
  reviewsOf: (pr: number) => readonly RecordedReview[]
}

export function cardDecisionReads(db: DatabaseSync, decisions: readonly BoundDecision[], reviewsOfAPr: string, storedByKey: (db: DatabaseSync, dedupeKey: string) => { id: number } | undefined): CardDecisionReads {
  return { decisions, decidedAt: decisionId => storedByKey(db, `${DECISION_RECORDED}:${decisionId}`)?.id, reviewsOf: pr => db.prepare(reviewsOfAPr).all(pr) as unknown as RecordedReview[] }
}

interface DecidedRow {
  card_id: number
  pr: number | null
}

interface ReviewTask {
  cardId: number
  pr?: number
  head?: string
}

export interface ReopenedReview extends DecidedRow {
  task_key: string
  queue: Queue
  head: string | null
  failure: number
  cause: string
}

function cardDecisionUnreviewedAt(reads: CardDecisionReads, cardId: number, pr: number | null | undefined): number | undefined {
  const latest = latestCardDecision(reads.decisions, cardId)
  if (latest === undefined || pr === null || pr === undefined)
    return undefined
  const decidedAt = reads.decidedAt(latest)
  return decidedAt === undefined || reads.reviewsOf(pr).some(review => Number(review.id) > decidedAt && review.verdict === 'pass') ? undefined : decidedAt
}

export function unreviewedUnderTheCardDecision(reads: CardDecisionReads): (row: DecidedRow) => boolean {
  return row => cardDecisionUnreviewedAt(reads, row.card_id, row.pr) !== undefined
}

export function reviewedUnderTheCardDecision(reads: CardDecisionReads): (row: DecidedRow) => boolean {
  return row => cardDecisionUnreviewedAt(reads, row.card_id, row.pr) === undefined
}

export function reviewsTheCardDecisionReopens<Task extends ReviewTask>(reads: CardDecisionReads, reviews: readonly Task[], keyOf: (review: Task) => string, taskOf: (key: string) => { state: string, event_id: number } | undefined): ReopenedReview[] {
  return [...new Map(reviews.map(review => [keyOf(review), review])).values()].flatMap((review) => {
    const decidedAt = cardDecisionUnreviewedAt(reads, review.cardId, review.pr)
    const task = taskOf(keyOf(review))
    if (decidedAt === undefined || task?.state !== 'completed' || Number(task.event_id) >= decidedAt || reads.reviewsOf(review.pr!).at(-1)?.verdict === 'changes')
      return []
    return [{ task_key: keyOf(review), queue: 'review', card_id: review.cardId, pr: review.pr ?? null, head: review.head ?? null, failure: decidedAt, cause: A_CARD_DECISION_REOPENS }]
  })
}

export interface CardSql {
  cardBody: (card: string) => string
  latestTurn: (card: string) => string
  notAWindowCard: (card: string) => string
  downgradeWaitOpenOn: (card: string) => string
}

interface EventValue {
  id: number
  type: string
  dedupe_key: string
  data: Record<string, unknown> | null
}

interface EventQuery {
  types?: readonly string[]
  keys?: readonly string[]
  ids?: readonly number[]
  pr?: number | null
  legacy?: boolean | 'either'
  newestFirst?: boolean
  limit?: number
}

interface TaskValue {
  task_key: string
  queue: string
  card_id: number
  pr: number | null
  state: string
  lease_gen: number
}

export interface ContinuationReads {
  events: (db: DatabaseSync, query: EventQuery) => readonly EventValue[]
  taskOf: (db: DatabaseSync, taskKey: string) => TaskValue | null
  answersOfCard: (db: DatabaseSync, cardId: number) => readonly TaskValue[]
  answers: (db: DatabaseSync) => readonly TaskValue[]
  openPrOf: (db: DatabaseSync, cardId: number) => { pr: number, head: string | null } | null
}

const CARD_PARAMETER = ':card'
const STOPPED_BY = `${CARD_STOPPED}:`
const THE_STOP_SEGMENT = ':stop-'

export function cardFragmentsQuery(sql: CardSql): string {
  return `SELECT ${sql.cardBody(CARD_PARAMETER)} AS card_body, ${sql.latestTurn(CARD_PARAMETER)} AS turn,
    ${sql.notAWindowCard(CARD_PARAMETER)} AS not_a_window_card, ${sql.downgradeWaitOpenOn(CARD_PARAMETER)} AS downgrade_wait_open`
}

interface CardFragments {
  card_body: unknown
  turn: number | null
  not_a_window_card: number | null
  downgrade_wait_open: number | null
}

function holds(condition: number | null): boolean {
  return condition !== null && Number(condition) !== 0
}

function fails(condition: number | null): boolean {
  return condition !== null && Number(condition) === 0
}

function keyEndsWith(taskKey: string, ending: string): boolean {
  return taskKey.toLowerCase().endsWith(ending.toLowerCase())
}

function writtenByAnAnswerOnAPr(db: DatabaseSync, stop: EventValue, reads: ContinuationReads): boolean {
  if (!stop.dedupe_key.startsWith(STOPPED_BY))
    return false
  const written = stop.dedupe_key.slice(STOPPED_BY.length)
  const at = written.lastIndexOf(':')
  const writer = at < 0 ? null : reads.taskOf(db, written.slice(0, at))
  return writer !== null && writer.queue === 'answer' && writer.pr !== null && !writer.task_key.toLowerCase().includes(THE_STOP_SEGMENT) && String(writer.lease_gen) === written.slice(at + 1)
}

function aQuestionADecisionAnswers(db: DatabaseSync, stop: EventValue, openPr: number | null, reads: ContinuationReads): boolean {
  const reason = stop.data?.reason
  return (reason === QUESTION_OWNER && !writtenByAnAnswerOnAPr(db, stop, reads)) || (reason === QUESTION_AGENT && openPr !== null)
}

function ownerStopOf(db: DatabaseSync, turn: number | null, decidedAt: number, openPr: number | null, reads: ContinuationReads): number | null {
  if (turn === null)
    return null
  const stop = reads.events(db, { ids: [Number(turn)], legacy: 'either' })[0]
  return stop !== undefined && stop.type === CARD_STOPPED && stop.id < decidedAt && aQuestionADecisionAnswers(db, stop, openPr, reads) ? stop.id : null
}

function aLiveTaskOfTheDecision(db: DatabaseSync, cardId: number, decision: number, reads: ContinuationReads): boolean {
  return reads.answersOfCard(db, cardId).some(task => keyEndsWith(task.task_key, `:decision-${decision}`) && !ENDED_WITHOUT_RUNNING.includes(task.state))
}

export function cardDecisionTurn(db: DatabaseSync, sql: CardSql, reads: ContinuationReads, decision: number, cardId: number): CardDecisionTurn | null {
  const decided = reads.events(db, { types: [DECISION_RECORDED], keys: [`${DECISION_RECORDED}:${decision}`] })[0]
  if (decided === undefined)
    return null
  const fragments = db.prepare(cardFragmentsQuery(sql)).get({ card: cardId }) as unknown as CardFragments
  if (!holds(fragments.not_a_window_card) || !fails(fragments.downgrade_wait_open) || aLiveTaskOfTheDecision(db, cardId, decision, reads))
    return null
  const open = reads.openPrOf(db, cardId)
  const lastReview = open === null ? undefined : reads.events(db, { types: [REVIEW_RECORDED], pr: open.pr, newestFirst: true, limit: 1 })[0]
  return {
    decision,
    decided_at: decided.id,
    card_id: cardId,
    pr: open?.pr ?? null,
    head: open?.head ?? null,
    card_body: fragments.card_body,
    last_review: lastReview?.id ?? null,
    owner_stop: ownerStopOf(db, fragments.turn, decided.id, open?.pr ?? null, reads),
  }
}

export interface CardDecisionTurn {
  decision: number
  decided_at: number
  card_id: number
  pr: number | null
  head: string | null
  card_body: unknown
  last_review: number | null
  owner_stop: number | null
}

export type PastTheRoundLimit = (pr: number, head: string | null) => boolean

export function continuesTheCard(turn: CardDecisionTurn, pastTheLimit: PastTheRoundLimit): boolean {
  if (turn.owner_stop !== null)
    return true
  return turn.pr !== null && turn.decided_at > (turn.last_review ?? 0) && pastTheLimit(turn.pr, turn.head)
}

export interface DecidedTask {
  decision?: number
}

export interface DecidedContinuations {
  decisions: readonly BoundDecision[]
  sql: CardSql
  pastTheLimit: PastTheRoundLimit
  cardBodyOf: (turn: CardDecisionTurn) => string | undefined
}

export function decidedContinuations(db: DatabaseSync, how: DecidedContinuations, reads: ContinuationReads): QueuedTask[] {
  const bound = how.decisions.filter(decision => decision.cards.length > 0)
  if (bound.length === 0)
    return []
  return bound
    .flatMap(decision => decision.cards.flatMap((card) => {
      const turn = cardDecisionTurn(db, how.sql, reads, decision.decisionId, card)
      return turn === null ? [] : [turn]
    }))
    .filter(turn => continuesTheCard(turn, how.pastTheLimit))
    .map(turn => ({ queue: 'answer', cardId: turn.card_id, pr: turn.pr ?? undefined, head: turn.head ?? undefined, cardBody: how.cardBodyOf(turn), decision: turn.decision }))
}

function anAnswerTheStopAlreadySpent(db: DatabaseSync, task: QueuedTask, reads: ContinuationReads): boolean {
  return task.stop !== undefined && reads.answersOfCard(db, task.cardId).some(answer => !LIVE_ANSWER_STATES.includes(answer.state) && keyEndsWith(answer.task_key, `${THE_STOP_SEGMENT}${task.stop}`))
}

function cardsWithALiveAnswer(db: DatabaseSync, reads: ContinuationReads): number[] {
  return reads.answers(db).filter(answer => LIVE_ANSWER_STATES.includes(answer.state)).map(answer => answer.card_id)
}

export function oneContinuationPerCard(db: DatabaseSync, planned: readonly QueuedTask[], decided: readonly QueuedTask[], reads: ContinuationReads): QueuedTask[] {
  const answering = planned.filter(task => !anAnswerTheStopAlreadySpent(db, task, reads))
  const answered = new Set([...answering.map(task => task.cardId), ...cardsWithALiveAnswer(db, reads)])
  const first = new Map<number, QueuedTask>()
  for (const task of decided) {
    if (!answered.has(task.cardId) && !first.has(task.cardId))
      first.set(task.cardId, task)
  }
  return [...first.values()]
}

export function withDecidedContinuations(db: DatabaseSync, planned: readonly QueuedTask[], how: DecidedContinuations, reads: ContinuationReads): QueuedTask[] {
  const decided = decidedContinuations(db, how, reads)
  return decided.length === 0 ? [...planned] : [...planned, ...oneContinuationPerCard(db, planned, decided, reads)]
}

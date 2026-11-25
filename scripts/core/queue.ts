import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { BoundDecision, Queue, TaskIdentity } from './identifiers.js'
import type { Fold, StoredEvent } from './stored.js'
import type { IncrementalProjection } from './watermark.js'
import { appendEvent, inTransaction } from './db.js'
import { dependencyWaitOf, mergedCardsBinding } from './dependency-wait.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_CLOSED, CARD_RELEASED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, declaredPart, INTAKE_EVENT, INTAKE_MOVE_EVENT, MERGE_DONE, POLICY_DENIED, PR_CLOSED, PR_GROUPS, PR_OBSERVED, PR_OPENED, QUESTION_AGENT, QUESTION_OWNER, SCOPE_WIDENED, SESSION_HEARTBEAT, TASK_COMPLETED, TASK_ENQUEUED, TASK_EXPIRED, TASK_FAILED, TASK_LEASED, TASK_RELEASED, TASK_RENEWED, TASK_REQUEUED, TASK_SUPERSEDED, TASK_WITHDRAWN } from './events.js'
import { A_CARD_DECISION_REOPENS, answerDecisionOfKey, BACKFILL_SOURCE, cardDecisionKeyOf, decidedTaskDecisionOfKey, decisionSegment, generationOfKey, isFullSha, MAIN_BRANCH, QUEUES, reviewInputOf, reviewInputOfKey, taskKey } from './identifiers.js'
import { payloadOf, reject } from './stored.js'
import { lastEventId, markReduced, reduceProjection, watermarkOf } from './watermark.js'

export const LEASE_MS = 30 * 60_000
export const SESSION_HELD_QUEUES: readonly Queue[] = ['review']
export const QUEUE_ACTOR = 'policy'
export const FAILURES_TO_STOP = 3

export const QUEUED = 'queued'
export const LEASED = 'leased'
export const WITHDRAWN = 'withdrawn'
export const COMPLETED = 'completed'
export const STOPPED = 'stopped'
export const SUPERSEDED = 'superseded'
export const FAULT = 'fault'
const REQUEUABLE = new Set([STOPPED, WITHDRAWN, SUPERSEDED])
const REQUEUABLE_AFTER_COMPLETION = new Set([...REQUEUABLE, COMPLETED])
const UNFINISHED = new Set([QUEUED, LEASED, STOPPED])
const AFTER_A_LEASE = new Set([QUEUED, WITHDRAWN, STOPPED])

export const UNFINISHED_STATES = [...UNFINISHED].map(state => `'${state}'`).join(', ')

export interface RoundTask {
  queue: Queue
  pr: number | null
  head: string | null
}

export type MayRequeue = (db: DatabaseSync, ts: string, task: RoundTask) => boolean

export interface CandidatePr {
  pr: number
  card_id: number | null
  base: string | null
  head: string | null
  state: string | null
  mergeable: string | null
  ci: string | null
  verdict_on_head: string | null
  draft: number | null
  body_sha: string | null
}

export type ReviewedPr = Pick<CandidatePr, 'pr' | 'head' | 'state' | 'ci' | 'verdict_on_head' | 'body_sha'>

export interface CandidateRules {
  prs: (db: DatabaseSync) => readonly CandidatePr[]
  mayRequeue: MayRequeue
  decisionsAt: (db: DatabaseSync, ts: string) => readonly BoundDecision[]
  mergeDecided: (db: DatabaseSync, ts: string, pr: number | null, head: string | null) => number | null
  outOfRounds: (db: DatabaseSync, queue: Queue, pr: number | null) => boolean
  reviewedUnderTheCardDecision: (db: DatabaseSync, ts: string) => (row: { card_id: number, pr: number | null }) => boolean
  mergedCards: (db: DatabaseSync) => readonly number[]
}

export type QuestionAnswered = (stop: string) => string

function latestBodyAdmission(card: string, columns: string): string {
  return `
    SELECT ${columns} FROM events AS intake
    WHERE intake.card_id = ${card} AND json_type(intake.payload, '$.bodySha') = 'text'
      AND ((intake.legacy = 1 AND intake.type IN ('${INTAKE_EVENT}', '${INTAKE_MOVE_EVENT}')) OR (intake.legacy = 0 AND intake.type = '${CARD_ADMITTED}'))
    ORDER BY intake.id DESC LIMIT 1
  `
}

export function cardBodyShaOf(card: string): string {
  return `(${latestBodyAdmission(card, `json_extract(intake.payload, '$.bodySha')`)})`
}

const UNDER_A_PR_BODY = ':pr-body-'
const LIVE_STATES: readonly string[] = [QUEUED, LEASED]

interface ReviewTaskRow extends TaskRow {
  state: string
  event_id: number
}

function reviewTasks(db: DatabaseSync): ReviewTaskRow[] {
  return db.prepare(`SELECT task_key, queue, card_id, pr, head, state, event_id FROM tasks WHERE queue = 'review' ORDER BY task_key`).all() as unknown as ReviewTaskRow[]
}

function onTheHead(task: { pr: number | null, head: string | null }, pr: { pr: number, head: string | null }): boolean {
  return task.pr === pr.pr && task.head !== null && task.head === pr.head
}

function inPrOrder<Pr extends { pr: number }>(prs: readonly Pr[]): Pr[] {
  return [...prs].sort((left, right) => left.pr - right.pr)
}

function withTheCardBody<Row extends { card_id: number }>(db: DatabaseSync, row: Row): Row & { card_body: string | null } {
  return { ...row, card_body: cardBodyShaOfCard(db, row.card_id) }
}

function reviewCandidateRows(db: DatabaseSync, prs: readonly CandidatePr[]): Candidate[] {
  const reviews = reviewTasks(db)
  return inPrOrder(prs).flatMap((pr) => {
    const onIt = reviews.filter(task => onTheHead(task, pr))
    const reviewedUnderAnInput = pr.body_sha !== null && onIt.some(task => task.task_key.includes(UNDER_A_PR_BODY))
    const due = pr.verdict_on_head === null || ((pr.verdict_on_head === 'changes' || pr.verdict_on_head === 'pass') && reviewedUnderAnInput)
    const plainReview = onIt.some(task => task.state !== SUPERSEDED && !task.task_key.includes(UNDER_A_PR_BODY))
    return pr.state === 'open' && pr.ci === 'green' && pr.card_id !== null && pr.head !== null && due && !plainReview ? [withTheCardBody(db, { pr: pr.pr, card_id: pr.card_id, head: pr.head, body_sha: pr.body_sha })] : []
  })
}

function reviewsOnTheHeadUnderABody(db: DatabaseSync, prs: readonly ReviewedPr[], admits: (task: ReviewTaskRow, pr: ReviewedPr) => boolean): (ReviewRow & { event_id: number })[] {
  const known = new Map(prs.map(pr => [pr.pr, pr]))
  return reviewTasks(db).flatMap((task) => {
    const pr = task.pr === null ? undefined : known.get(task.pr)
    if (pr === undefined || pr.body_sha === null || !onTheHead(task, pr) || !task.task_key.includes(UNDER_A_PR_BODY) || !admits(task, pr))
      return []
    return [withTheCardBody(db, { task_key: task.task_key, queue: task.queue, card_id: task.card_id, pr: task.pr, head: task.head, event_id: task.event_id, body_sha: pr.body_sha })]
  })
}

function supersededReviewsOnTheCurrentHead(db: DatabaseSync, prs: readonly ReviewedPr[]): SupersededReviewRow[] {
  const live = new Set(reviewTasks(db).filter(task => LIVE_STATES.includes(task.state)).map(task => task.pr))
  const due = (task: ReviewTaskRow, pr: ReviewedPr): boolean => task.state === SUPERSEDED && pr.state === 'open' && pr.ci === 'green' && (pr.verdict_on_head === null || pr.verdict_on_head === 'changes') && !live.has(task.pr)
  return reviewsOnTheHeadUnderABody(db, prs, due).map(({ event_id, ...row }) => ({ ...row, failure: Number(event_id) }))
}

function reviewsOfAnOldInputRows(db: DatabaseSync, prs: readonly ReviewedPr[]): ReviewRow[] {
  return reviewsOnTheHeadUnderABody(db, prs, task => LIVE_STATES.includes(task.state)).map(({ event_id: _event, ...row }) => row)
}

const ANSWER_TASK_COLUMNS = 'task_key, queue, card_id, pr, head, state'

function answerTasksWhere(columns: string, match: string, order: string): string {
  return `
  SELECT ${columns} FROM tasks
  WHERE queue = 'answer' AND ${match}
  ORDER BY ${order}
`
}

const LIVE_ANSWERS_WITH_THE_CARD_BODY = answerTasksWhere(`${ANSWER_TASK_COLUMNS}, ${cardBodyShaOf('tasks.card_id')} AS card_body`, `state IN ('${QUEUED}', '${LEASED}')`, 'task_key')

const LATEST_ANSWER_OF_THE_CARD = answerTasksWhere(ANSWER_TASK_COLUMNS, 'card_id = ?', 'id DESC LIMIT 1')

const A_SUPERSEDED_ANSWER_WITHIN_ITS_LEASE = `
  SELECT 1 FROM tasks
  WHERE queue = 'answer' AND state = '${SUPERSEDED}' AND card_id = ? AND lease_until > ?
  LIMIT 1
`

const DEPENDENCY_WAIT = dependencyWaitOf({ admitted: CARD_ADMITTED, backfillSource: BACKFILL_SOURCE, mergeDone: MERGE_DONE, prClosed: PR_CLOSED, prOpened: PR_OPENED, prObserved: PR_OBSERVED, settledUpdateStates: [COMPLETED, WITHDRAWN, STOPPED], verified: CARD_VERIFIED })

export const { unmerged: A_DEPENDENCY_UNMERGED, updateDue: A_DEPENDENCY_UPDATE_DUE, held: HELD_BY_A_DEPENDENCY } = DEPENDENCY_WAIT

export const { unmergedDependenciesOf, updateDueOn: dependencyUpdateDueOn } = DEPENDENCY_WAIT

function tasksInFlight(columns: string, queue: string, match: string): string {
  return `SELECT ${columns} FROM tasks AS live WHERE live.queue = '${queue}' AND ${match}
    AND live.state IN ('${QUEUED}', '${LEASED}')`
}

export function aTaskInFlight(queue: string, match: string): string {
  return `EXISTS (${tasksInFlight('1', queue, match)})`
}

const REVIEWS_IN_FLIGHT_ON_THE_HEAD = `${tasksInFlight('live.task_key', 'review', 'live.pr = ? AND live.head = ?')} ORDER BY live.id`

export const NEEDS_UPDATE = 'needs_update'

export const A_MERGE_SENT_TO_UPDATE_ON_THE_HEAD = `(SELECT max(denied.id) FROM events AS denied
    WHERE denied.type = '${POLICY_DENIED}' AND denied.legacy = 0 AND denied.pr = prs.pr AND denied.head = prs.head
    AND json_extract(denied.payload, '$.command') = 'merge' AND json_extract(denied.payload, '$.reason') = '${NEEDS_UPDATE}')`

const MERGE_SENT_TO_UPDATE_ON_A_HEAD = `SELECT max(id) AS id FROM events WHERE type = '${POLICY_DENIED}' AND legacy = 0 AND pr = ? AND head = ?
    AND json_extract(payload, '$.command') = 'merge' AND json_extract(payload, '$.reason') = '${NEEDS_UPDATE}'`

function mergeCandidatesWhere(db: DatabaseSync, prs: readonly CandidatePr[], mergedCards: readonly number[], verdict: (verdict: string | null) => boolean, mergeable: readonly string[]): Candidate[] {
  const inFlight = reviewTasks(db).filter(task => LIVE_STATES.includes(task.state))
  const sentToUpdate = (pr: number, head: string): boolean => (db.prepare(MERGE_SENT_TO_UPDATE_ON_A_HEAD).get(pr, head) as { id: number | null }).id !== null
  return inPrOrder(prs).flatMap((pr) => {
    const gated = pr.state === 'open' && pr.base === MAIN_BRANCH && pr.ci === 'green' && verdict(pr.verdict_on_head) && pr.mergeable !== null && mergeable.includes(pr.mergeable) && pr.draft === 0
    if (!gated || pr.card_id === null || pr.head === null || unmergedDependenciesOf(db, mergedCards, pr.card_id).length > 0 || inFlight.some(task => onTheHead(task, pr)) || sentToUpdate(pr.pr, pr.head))
      return []
    return [withTheCardBody(db, { pr: pr.pr, card_id: pr.card_id, head: pr.head, body_sha: pr.body_sha })]
  })
}

export function mergeCandidateRows(db: DatabaseSync, prs: readonly CandidatePr[], mergedCards: readonly number[]): Candidate[] {
  return mergeCandidatesWhere(db, prs, mergedCards, verdict => verdict === 'pass', ['clean', 'behind'])
}

export function mergeCandidateRowsWithoutPass(db: DatabaseSync, prs: readonly CandidatePr[], mergedCards: readonly number[]): Candidate[] {
  return mergeCandidatesWhere(db, prs, mergedCards, verdict => verdict !== 'pass', ['clean', 'blocked'])
}

const LATEST = 'id DESC LIMIT 1'

function eventsWhere(columns: string, match: string, order: string): string {
  return `SELECT ${columns} FROM events WHERE ${match} AND legacy = 0 ORDER BY ${order}`
}

const LATEST_ORDER = eventsWhere('id, ts, type, actor, card_id, pr, head, dedupe_key, payload, legacy', `type = '${PR_GROUPS}'`, LATEST)

const LATEST_RELEASE_OF_THE_CARD = eventsWhere(`id, json_extract(payload, '$.request') AS request`, `card_id = ? AND type = '${CARD_RELEASED}'`, LATEST)

const LATEST_WIDEN_STOP_OF_THE_CARD = eventsWhere(
  `id, json_extract(payload, '$.detail') AS detail, json_extract(payload, '$.widen') AS widen`,
  `card_id = ? AND type = '${CARD_STOPPED}' AND json_extract(payload, '$.reason') = '${QUESTION_OWNER}' AND json_array_length(json_extract(payload, '$.widen')) > 0`,
  LATEST,
)

const WIDENED_ON_THE_ADMISSION = eventsWhere(
  `json_extract(payload, '$.paths') AS paths`,
  `card_id = ? AND type = '${SCOPE_WIDENED}' AND json_extract(payload, '$.admission') = ? AND json_type(payload, '$.paths') = 'array'`,
  'id',
)

export interface CardRelease {
  id: number
  request: number | null
}

export function latestReleaseOf(db: DatabaseSync, cardId: number): CardRelease | null {
  const row = db.prepare(LATEST_RELEASE_OF_THE_CARD).get(cardId) as { id: number, request: unknown } | undefined
  return row === undefined ? null : { id: Number(row.id), request: typeof row.request === 'number' ? row.request : null }
}

export interface WidenStop {
  id: number
  detail: unknown
  widen: string[]
}

export function latestWidenStopOf(db: DatabaseSync, cardId: number): WidenStop | null {
  const row = db.prepare(LATEST_WIDEN_STOP_OF_THE_CARD).get(cardId) as { id: number, detail: unknown, widen: string } | undefined
  if (row === undefined)
    return null
  const widen = (JSON.parse(row.widen) as unknown[]).filter((each): each is string => typeof each === 'string')
  return { id: Number(row.id), detail: row.detail, widen }
}

export function widenedOnTheAdmission(db: DatabaseSync, cardId: number, admission: number): string[] {
  return (db.prepare(WIDENED_ON_THE_ADMISSION).all(cardId, admission) as { paths: string }[]).flatMap(row => JSON.parse(row.paths) as string[])
}

export interface TaskStateRow extends TaskRow {
  state: string
}

export function latestAnswerOf(db: DatabaseSync, cardId: number): TaskStateRow | null {
  return (db.prepare(LATEST_ANSWER_OF_THE_CARD).get(cardId) as TaskStateRow | undefined) ?? null
}

export function reviewsInFlightOn(db: DatabaseSync, pr: number | null, head: string | null): string[] {
  return (db.prepare(REVIEWS_IN_FLIGHT_ON_THE_HEAD).all(pr, head) as { task_key: string }[]).map(row => row.task_key)
}

interface RecordedGroup {
  prs: readonly number[]
  turn: number | null
}

export interface RecordedOrder {
  groups: readonly RecordedGroup[]
  needUpdate: ReadonlySet<number>
}

export function recordedOrder(db: DatabaseSync): RecordedOrder {
  const row = db.prepare(LATEST_ORDER).get() as StoredEvent | undefined
  const payload: { groups?: unknown, needUpdate?: unknown } = row === undefined ? {} : declaredPart(PR_GROUPS, payloadOf(row))
  return { groups: Array.isArray(payload.groups) ? payload.groups as RecordedGroup[] : [], needUpdate: new Set(Array.isArray(payload.needUpdate) ? payload.needUpdate as number[] : []) }
}

export function holdsTheTurn(order: RecordedOrder, pr: number | null): boolean {
  return pr !== null && order.groups.some(group => group.turn === pr)
}

export function noTurnHeldBeside(order: RecordedOrder, pr: number | null): boolean {
  const group = order.groups.find(each => pr !== null && each.prs.includes(pr))
  return pr !== null && (group === undefined || group.turn === null)
}

export const MERGE_REFUSED = 'merge_refused'

export const QUESTION_OPEN = 'owner_question_open'

const VERIFICATIONS = `SELECT pr, card_id, max(json_type(payload, '$.sharedBy') = 'text') AS shared FROM events
  WHERE type = '${CARD_VERIFIED}' AND legacy = 0 AND card_id IS NOT NULL AND pr IS NOT NULL GROUP BY pr, card_id ORDER BY pr, card_id`

function closeCandidateRows(db: DatabaseSync, prs: readonly CandidatePr[]): Candidate[] {
  const merged = new Map(prs.filter(pr => pr.state === 'merged' && pr.card_id !== null && pr.head !== null).map(pr => [pr.pr, pr]))
  const closed = new Set((db.prepare(`SELECT card_id FROM events WHERE type = '${CARD_CLOSED}' AND card_id IS NOT NULL`).all() as { card_id: number }[]).map(row => Number(row.card_id)))
  return (db.prepare(VERIFICATIONS).all() as { pr: number, card_id: number, shared: number }[]).flatMap((row) => {
    const pr = merged.get(Number(row.pr))
    return pr !== undefined && (Number(row.card_id) === pr.card_id || row.shared === 1) && !closed.has(Number(row.card_id)) ? [{ pr: pr.pr, card_id: Number(row.card_id), head: pr.head }] : []
  })
}

const CARD_TURNS = `'${CARD_STOPPED}', '${CARD_ANSWERED}', '${CARD_STARTED}'`

export function latestTurnOf(card: string): string {
  return `(SELECT id FROM events AS turn WHERE turn.card_id = ${card} AND turn.legacy = 0 AND turn.type IN (${CARD_TURNS}) ORDER BY turn.id DESC LIMIT 1)`
}

export const ASKS_TO_WIDEN_THE_TOUCHES = `EXISTS (
  SELECT 1 FROM json_each(stop.payload, '$.widen') AS widen WHERE widen.type = 'text' AND widen.value != ''
)`

const THE_TURN_BEFORE_THE_STOP = `(
  SELECT id FROM events AS turn WHERE turn.card_id = stop.card_id AND turn.legacy = 0 AND turn.type IN (${CARD_TURNS}) AND turn.id < stop.id
  ORDER BY turn.id DESC LIMIT 1
)`

const ASKED_THE_SAME_QUESTION_JUST_BEFORE = `EXISTS (
  SELECT 1 FROM events AS before WHERE before.id = ${THE_TURN_BEFORE_THE_STOP} AND before.type = '${CARD_STOPPED}'
    AND json_extract(before.payload, '$.reason') = '${QUESTION_AGENT}'
    AND json_extract(before.payload, '$.detail') IS json_extract(stop.payload, '$.detail')
)`

export const ADMITTED_AFTER_THE_STOP = `EXISTS (
  SELECT 1 FROM events AS admitted WHERE admitted.type = '${CARD_ADMITTED}' AND admitted.legacy = 0 AND admitted.card_id = stop.card_id AND admitted.id > stop.id
)`

export const THE_WINDOW_AMENDS_THE_CARD_FIRST = `((${ASKS_TO_WIDEN_THE_TOUCHES} OR ${ASKED_THE_SAME_QUESTION_JUST_BEFORE}) AND NOT ${ADMITTED_AFTER_THE_STOP})`

export const LAUNCH_STOP_WITH_NO_PULL_REQUEST = `${CARD_STOPPED}:no-pull-request:`

export const A_LAUNCH_STOP_WITH_NO_PULL_REQUEST = `(stop.pr IS NULL AND substr(stop.dedupe_key, 1, ${LAUNCH_STOP_WITH_NO_PULL_REQUEST.length}) = '${LAUNCH_STOP_WITH_NO_PULL_REQUEST}')`

export const DOWNGRADE_WAIT_OPEN = 'downgrade_wait_open'

export function anOpenQuestion(answered: QuestionAnswered): string {
  return `(
  json_extract(stop.payload, '$.reason') = '${QUESTION_AGENT}'
  OR (json_extract(stop.payload, '$.reason') = '${QUESTION_OWNER}' AND NOT ${answered('stop')})
)`
}

export interface Candidate {
  pr: number | null
  card_id: number
  head: string | null
  verdict_on_head?: string | null
  stop?: number | null
  body_sha?: string | null
  card_body?: unknown
  witness_base?: string | null
  text?: unknown
}

export type Admits = (row: Candidate) => boolean

export const everyRow: Admits = () => true

export function decidedPastRoundLimit(db: DatabaseSync, ts: string, rules: CandidateRules): Admits {
  return row => rules.mergeDecided(db, ts, row.pr, row.head) !== null
}

export function aMergeCandidate(db: DatabaseSync, ts: string, rules: CandidateRules): Admits {
  const decided = decidedPastRoundLimit(db, ts, rules)
  return row => (row.verdict_on_head === 'pass' || decided(row)) && rules.mayRequeue(db, ts, { queue: 'merge', pr: row.pr, head: row.head })
}

export function candidateRows(db: DatabaseSync, query: string, admits: Admits, mergedCards: readonly number[]): Candidate[] {
  const statement = db.prepare(query)
  statement.setAllowUnknownNamedParameters(true)
  return (statement.all(mergedCardsBinding(mergedCards)) as unknown as Candidate[]).filter(admits)
}

export interface TaskRow {
  task_key: string
  queue: Queue
  card_id: number
  pr: number | null
  head: string | null
}

export interface RequeueRow extends TaskRow {
  failure: number
  cause?: string
  fault?: boolean
}

interface ReviewRow extends TaskRow {
  body_sha: string
  card_body: unknown
}

type SupersededReviewRow = ReviewRow & RequeueRow

export interface QueuedTask extends TaskIdentity {
  stop?: number
  cardBody?: string
  base?: string
  prBody?: string
  decision?: number
}

export interface QueueSource {
  queue?: Queue
  enqueue?: (db: DatabaseSync, ts: string) => QueuedTask[]
  requeue?: (db: DatabaseSync, ts: string) => RequeueRow[]
  settle?: (db: DatabaseSync, ts: string) => void
}

const CARD_BODY_QUEUES: readonly Queue[] = ['answer', 'witness', 'close']
const STOP_SUFFIX = /:stop-([1-9]\d*)$/
const BODY_SHA = /^[0-9a-f]{8,64}$/
const ANSWER_CARD_BODY = /:card-body-([0-9a-f]{8,64})(?::base-[0-9a-f]{40})?(?::decision-[1-9]\d*)?(?::stop-[1-9]\d*)?$/
const MERGE_PR_BODY = /:pr-body-([0-9a-f]{8,64})(?::decision-[1-9]\d*)?$/
const WITNESS_BASE = /:base-([0-9a-f]{40})(?::stop-[1-9]\d*)?$/

function cardBodySegment(task: QueuedTask): string {
  if (task.cardBody === undefined)
    return ''
  if (!CARD_BODY_QUEUES.includes(task.queue) || !BODY_SHA.test(task.cardBody))
    throw new Error(`only an answer task carries a card body sha, or a witness or a close task: ${task.queue}, ${task.cardBody}`)
  return `:card-body-${task.cardBody}`
}

function baseSegment(task: QueuedTask): string {
  if (task.base === undefined)
    return ''
  if (task.queue !== 'witness' || task.cardBody === undefined || !isFullSha(task.base))
    throw new Error(`only a witness task with a card body carries a base sha: ${task.queue}, ${task.base}`)
  return `:base-${task.base}`
}

function prBodySegment(task: QueuedTask): string {
  if (task.prBody === undefined)
    return ''
  if (task.queue !== 'merge' || task.pr === undefined || !BODY_SHA.test(task.prBody))
    throw new Error(`only a merge task of a pull request carries a pull request body sha: ${task.queue}, ${task.prBody}`)
  return `:pr-body-${task.prBody}`
}

export function baseOfKey(key: string): string | undefined {
  return WITNESS_BASE.exec(key)?.[1]
}

export function keyOf(task: QueuedTask): string {
  const key = `${taskKey(task)}${cardBodySegment(task)}${baseSegment(task)}${prBodySegment(task)}${decisionSegment(task)}`
  return task.stop === undefined ? key : `${key}:stop-${task.stop}`
}

export function answerCardBodyOf(row: Pick<Candidate, 'card_body'>): string | undefined {
  return typeof row.card_body === 'string' && BODY_SHA.test(row.card_body) ? row.card_body : undefined
}

function stopIn(key: unknown): number | undefined {
  const match = typeof key === 'string' ? STOP_SUFFIX.exec(key) : null
  return match === null ? undefined : Number(match[1])
}

function cardBodyIn(key: unknown): string | undefined {
  const match = typeof key === 'string' ? ANSWER_CARD_BODY.exec(key) : null
  return match === null ? undefined : match[1]
}

export function openCandidates(db: DatabaseSync, ts: string, queue: Queue, rows: Candidate[], rules: CandidateRules): QueuedTask[] {
  return rows.filter(row => rules.mayRequeue(db, ts, { queue, pr: row.pr, head: row.head })).map((row) => {
    const input = queue !== 'review' || row.body_sha === undefined ? undefined : reviewInputOf(row.body_sha, row.card_body)
    const cardBody = CARD_BODY_QUEUES.includes(queue) ? answerCardBodyOf(row) : undefined
    const base = queue === 'witness' && cardBody !== undefined ? row.witness_base ?? undefined : undefined
    const prBody = queue === 'merge' && typeof row.body_sha === 'string' && BODY_SHA.test(row.body_sha) ? row.body_sha : undefined
    return { queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined, stop: row.stop ?? undefined, input, cardBody, base, prBody, decision: cardDecisionKeyOf(queue, row.card_id, () => rules.decisionsAt(db, ts)) }
  })
}

export function reviewCandidates(db: DatabaseSync, ts: string, rules: CandidateRules): QueuedTask[] {
  const reviewed = rules.reviewedUnderTheCardDecision(db, ts)
  const prs = rules.prs(db)
  return [...openCandidates(db, ts, 'review', reviewCandidateRows(db, prs), rules), ...openCandidates(db, ts, 'review', mergeCandidateRows(db, prs, rules.mergedCards(db)).filter(row => !reviewed(row)), rules)]
}

export function closeCandidates(db: DatabaseSync, ts: string, rules: CandidateRules): QueuedTask[] {
  return openCandidates(db, ts, 'close', closeCandidateRows(db, rules.prs(db)), rules)
}

export interface Derived {
  queued: string[]
  superseded: string[]
}

export function identityOf(event: StoredEvent): { key: string, queue: Queue } {
  const payload = payloadOf(event)
  const queue = QUEUES.find(each => each === payload.queue) ?? reject(`queue is not one of ${QUEUES.join(' | ')}`)
  const cardId = event.card_id ?? reject(`${event.type} needs a card_id`)
  const generation = typeof payload.generation === 'string' ? payload.generation : undefined
  const stop = queue === 'answer' ? stopIn(payload.task_key) : undefined
  const cardBody = CARD_BODY_QUEUES.includes(queue) ? cardBodyIn(payload.task_key) : undefined
  const input = queue === 'review' ? reviewInputOfKey(payload.task_key) : undefined
  if (input !== undefined && (event.pr === null || event.head === null))
    reject(`${event.type} of a review input needs a pr and a head`)
  const base = queue === 'witness' ? baseOfKey(String(payload.task_key)) : undefined
  const prBody = queue === 'merge' ? MERGE_PR_BODY.exec(String(payload.task_key))?.[1] : undefined
  const key = keyOf({ queue, cardId, pr: event.pr ?? undefined, head: event.head ?? undefined, generation, stop, input, cardBody, base, prBody, decision: decidedTaskDecisionOfKey(queue, payload.task_key) })
  if (payload.task_key !== key)
    reject(`task_key ${String(payload.task_key)} is not ${key}`)
  return { key, queue }
}

export function taskRow(db: DatabaseSync, key: string): { state: string, event_id: number } | undefined {
  return db.prepare('SELECT state, event_id FROM tasks WHERE task_key = ?').get(key) as { state: string, event_id: number } | undefined
}

function foldEnqueued(db: DatabaseSync, event: StoredEvent): void {
  const { key, queue } = identityOf(event)
  if (taskRow(db, key) !== undefined)
    reject(`task ${key} is already queued`)
  db.prepare('INSERT INTO tasks (task_key, queue, card_id, pr, head, state, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(key, queue, event.card_id, event.pr, event.head, QUEUED, event.id)
}

function foldSuperseded(db: DatabaseSync, event: StoredEvent): void {
  const { key } = identityOf(event)
  const task = taskRow(db, key) ?? reject(`task ${key} was never queued`)
  if (task.state === SUPERSEDED)
    reject(`task ${key} is already superseded`)
  db.prepare('UPDATE tasks SET state = ?, event_id = ? WHERE task_key = ?').run(SUPERSEDED, event.id, key)
}

function foldRequeued(db: DatabaseSync, event: StoredEvent): void {
  const { key, queue } = identityOf(event)
  const task = taskRow(db, key) ?? reject(`task ${key} was never queued`)
  const requeuable = queue === 'answer' || queue === 'update' || (queue === 'review' && payloadOf(event).cause === A_CARD_DECISION_REOPENS) ? REQUEUABLE_AFTER_COMPLETION : REQUEUABLE
  if (!requeuable.has(task.state))
    reject(`task ${key} is ${task.state}, not ${[...requeuable].join(' or ')}`)
  const failures = payloadOf(event).fault === true ? 'failures + 1' : '0'
  db.prepare(`UPDATE tasks SET state = ?, failures = ${failures}, event_id = ? WHERE task_key = ?`).run(QUEUED, event.id, key)
}

function foldWithdrawn(db: DatabaseSync, event: StoredEvent): void {
  const { key } = identityOf(event)
  const task = taskRow(db, key) ?? reject(`task ${key} was never queued`)
  if (!UNFINISHED.has(task.state))
    reject(`task ${key} is ${task.state}, not ${[...UNFINISHED].join(' or ')}`)
  db.prepare('UPDATE tasks SET state = ?, event_id = ? WHERE task_key = ?').run(WITHDRAWN, event.id, key)
}

interface LeasedRow {
  task_key: string
  state: string
  lease_gen: number
}

function leasedRowOf(db: DatabaseSync, key: string): LeasedRow | undefined {
  return db.prepare('SELECT task_key, state, lease_gen FROM tasks WHERE task_key = ?').get(key) as LeasedRow | undefined
}

function leaseUntil(ts: string): string {
  return new Date(Date.parse(ts) + LEASE_MS).toISOString()
}

function leaseGenOf(payload: Record<string, unknown>): number {
  const value = payload.lease_gen
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : reject('lease_gen is not a positive integer')
}

function heldRow(db: DatabaseSync, event: StoredEvent): { row: LeasedRow, payload: Record<string, unknown> } {
  const { key } = identityOf(event)
  const payload = payloadOf(event)
  const row = leasedRowOf(db, key) ?? reject(`task ${key} was never queued`)
  if (row.state !== LEASED || row.lease_gen !== leaseGenOf(payload))
    reject(`task ${key} is not leased under lease_gen ${String(payload.lease_gen)}`)
  return { row, payload }
}

function foldLeased(db: DatabaseSync, event: StoredEvent): void {
  const { key } = identityOf(event)
  const payload = payloadOf(event)
  const row = leasedRowOf(db, key) ?? reject(`task ${key} was never queued`)
  if (row.state !== QUEUED)
    reject(`task ${key} is ${row.state}, not queued`)
  if (leaseGenOf(payload) !== row.lease_gen + 1)
    reject(`lease_gen ${String(payload.lease_gen)} does not follow ${row.lease_gen}`)
  db.prepare('UPDATE tasks SET state = ?, lease_gen = ?, lease_until = ?, event_id = ? WHERE task_key = ?')
    .run(LEASED, row.lease_gen + 1, leaseUntil(event.ts), event.id, key)
}

function foldRenewed(db: DatabaseSync, event: StoredEvent): void {
  const { row } = heldRow(db, event)
  db.prepare('UPDATE tasks SET lease_until = ?, event_id = ? WHERE task_key = ?').run(leaseUntil(event.ts), event.id, row.task_key)
}

function foldCompleted(db: DatabaseSync, event: StoredEvent): void {
  const { row } = heldRow(db, event)
  db.prepare('UPDATE tasks SET state = ?, lease_until = NULL, event_id = ? WHERE task_key = ?').run(COMPLETED, event.id, row.task_key)
}

function foldFailed(db: DatabaseSync, event: StoredEvent): void {
  const { row, payload } = heldRow(db, event)
  const next = typeof payload.next === 'string' && AFTER_A_LEASE.has(payload.next) ? payload.next : reject(`next is not one of ${[...AFTER_A_LEASE].join(' | ')}`)
  const counted = payload.uncounted === true ? 0 : 1
  db.prepare('UPDATE tasks SET state = ?, lease_until = NULL, failures = failures + ?, event_id = ? WHERE task_key = ?').run(next, counted, event.id, row.task_key)
}

function foldReleased(db: DatabaseSync, event: StoredEvent): void {
  const { row } = heldRow(db, event)
  db.prepare('UPDATE tasks SET state = ?, lease_until = NULL, event_id = ? WHERE task_key = ?').run(QUEUED, event.id, row.task_key)
}

function foldHeartbeat(db: DatabaseSync, event: StoredEvent): void {
  if (event.card_id === null)
    reject('a heartbeat names no card')
  const payload = payloadOf(event)
  if (typeof payload.task_key !== 'string')
    return
  db.prepare(`UPDATE tasks SET lease_until = ? WHERE state = '${LEASED}' AND task_key = ? AND lease_gen = ? AND card_id = ?`)
    .run(leaseUntil(event.ts), payload.task_key, leaseGenOf(payload), event.card_id)
}

const QUEUE_FOLDS: Record<string, Fold> = {
  [TASK_ENQUEUED]: foldEnqueued,
  [TASK_SUPERSEDED]: foldSuperseded,
  [TASK_REQUEUED]: foldRequeued,
  [TASK_WITHDRAWN]: foldWithdrawn,
}

const LEASE_TASK_FOLDS: Record<string, Fold> = {
  [SESSION_HEARTBEAT]: foldHeartbeat,
  [TASK_RELEASED]: foldReleased,
  [TASK_LEASED]: foldLeased,
  [TASK_RENEWED]: foldRenewed,
  [TASK_COMPLETED]: foldCompleted,
  [TASK_FAILED]: foldFailed,
  [TASK_EXPIRED]: foldFailed,
}

const TASKS_FOLDS: Record<string, Fold> = { ...QUEUE_FOLDS, ...LEASE_TASK_FOLDS }

export const TASKS_PROJECTION: IncrementalProjection = { table: 'tasks', folds: TASKS_FOLDS }

function reduceTasksAfter(db: DatabaseSync, current: number): void {
  if (watermarkOf(db, TASKS_PROJECTION.table) === 0)
    markReduced(db, TASKS_PROJECTION.table, current)
  reduceProjection(db, TASKS_PROJECTION)
}

export function appendedAndReduced(db: DatabaseSync, event: BusEvent): boolean {
  const current = lastEventId(db)
  const appended = appendEvent(db, event)
  reduceTasksAfter(db, current)
  return appended
}

function reducedAfterItsAppend(db: DatabaseSync, event: StoredEvent): void {
  reduceTasksAfter(db, event.id - 1)
}

function reducedOnAppend(folds: Record<string, Fold>): Record<string, Fold> {
  return Object.fromEntries(Object.keys(folds).map(type => [type, reducedAfterItsAppend]))
}

export const TASK_FOLDS = reducedOnAppend(QUEUE_FOLDS)
export const LEASE_FOLDS = reducedOnAppend(LEASE_TASK_FOLDS)

export function generationField(generation: string | undefined): { generation?: string } {
  return generation === undefined ? {} : { generation }
}

function taskEvent(ts: string, type: string, task: QueuedTask, failure?: number, state?: number, fault = false): BusEvent {
  const key = keyOf(task)
  const after = failure === undefined ? {} : fault ? { failure, fault } : { failure }
  const plain = failure === undefined ? `${type}:${key}` : `${type}:${key}:${failure}`
  const dedupeKey = state === undefined ? plain : `${plain}:after-${state}`
  return { ts, type, actor: QUEUE_ACTOR, cardId: task.cardId, pr: task.pr ?? null, head: task.head ?? null, dedupeKey, payload: { task_key: key, queue: task.queue, ...generationField(task.generation), ...after }, legacy: false }
}

function written(db: DatabaseSync, event: BusEvent): boolean {
  return inTransaction(db, () => appendedAndReduced(db, event))
}

export function queueTaskWithin(db: DatabaseSync, ts: string, task: QueuedTask): boolean {
  return appendedAndReduced(db, taskEvent(ts, TASK_ENQUEUED, task))
}

export function queueTask(db: DatabaseSync, ts: string, task: QueuedTask): boolean {
  return written(db, taskEvent(ts, TASK_ENQUEUED, task))
}

function stateEventOf(db: DatabaseSync, task: QueuedTask): number | undefined {
  const row = db.prepare('SELECT event_id FROM tasks WHERE task_key = ?').get(keyOf(task)) as { event_id: number } | undefined
  return row === undefined ? undefined : Number(row.event_id)
}

export function supersedeTask(db: DatabaseSync, ts: string, task: QueuedTask): boolean {
  return written(db, taskEvent(ts, TASK_SUPERSEDED, task, undefined, stateEventOf(db, task)))
}

export function withdrawTask(db: DatabaseSync, ts: string, task: QueuedTask, reason?: string): boolean {
  const event = taskEvent(ts, TASK_WITHDRAWN, task, undefined, stateEventOf(db, task))
  return written(db, reason === undefined ? event : { ...event, payload: { ...event.payload as Record<string, unknown>, reason } })
}

export function identityOfRow(row: TaskRow): QueuedTask {
  const plain = { queue: row.queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined }
  const input = row.queue === 'review' ? reviewInputOfKey(row.task_key) : undefined
  const cardBody = CARD_BODY_QUEUES.includes(row.queue) ? cardBodyIn(row.task_key) : undefined
  const base = row.queue === 'witness' ? baseOfKey(row.task_key) : undefined
  const prBody = row.queue === 'merge' ? MERGE_PR_BODY.exec(row.task_key)?.[1] : undefined
  return { ...plain, generation: generationOfKey(row.task_key, plain), stop: stopIn(row.task_key), input, cardBody, base, prBody, decision: decidedTaskDecisionOfKey(row.queue, row.task_key) }
}

export interface BodyAdmission { bodySha: string, event: string }

export function cardBodyAdmissionOf(db: DatabaseSync, cardId: number): BodyAdmission | null {
  const row = db.prepare(latestBodyAdmission('?', `json_extract(intake.payload, '$.bodySha') AS body_sha, intake.dedupe_key AS event`)).get(cardId) as { body_sha: unknown, event: unknown } | undefined
  return typeof row?.body_sha === 'string' && typeof row.event === 'string' ? { bodySha: row.body_sha, event: row.event } : null
}

export function cardBodyShaOfCard(db: DatabaseSync, cardId: number): string | null {
  return cardBodyAdmissionOf(db, cardId)?.bodySha ?? null
}

export function reviewsOfAnOldInput(db: DatabaseSync, prs: readonly ReviewedPr[]): TaskRow[] {
  return reviewsOfAnOldInputRows(db, prs).filter(row => !underCurrentInput(row))
}

function keyedOnAnOldCardBody(key: string, row: Pick<Candidate, 'card_body'>): boolean {
  const current = answerCardBodyOf(row)
  return current !== undefined && cardBodyIn(key) !== current
}

function leaseOnAnOldCardBody(key: string, row: Pick<Candidate, 'card_body'>): boolean {
  return cardBodyIn(key) !== undefined && keyedOnAnOldCardBody(key, row)
}

export function answersOfAnOldCardBody(db: DatabaseSync): TaskRow[] {
  return (db.prepare(LIVE_ANSWERS_WITH_THE_CARD_BODY).all() as unknown as (TaskRow & Pick<Candidate, 'card_body'> & { state: string })[])
    .filter(row => row.state === QUEUED ? keyedOnAnOldCardBody(row.task_key, row) : leaseOnAnOldCardBody(row.task_key, row))
}

export function answerOnAnOldCardBody(db: DatabaseSync, task: { taskKey: string, cardId: number }): boolean {
  return leaseOnAnOldCardBody(task.taskKey, { card_body: cardBodyShaOfCard(db, task.cardId) })
}

export function supersededAnswerWithinItsLease(db: DatabaseSync, cardId: number, ts: string): boolean {
  return db.prepare(A_SUPERSEDED_ANSWER_WITHIN_ITS_LEASE).get(cardId, ts) !== undefined
}

export function reviewKeysOfAnOldInput(db: DatabaseSync, prs: readonly ReviewedPr[]): string[] {
  return reviewsOfAnOldInput(db, prs).map(row => row.task_key)
}

export function reviewsOfTheCurrentInputAgain(db: DatabaseSync, prs: readonly ReviewedPr[]): RequeueRow[] {
  return supersededReviewsOnTheCurrentHead(db, prs).filter(underCurrentInput)
}

export function reviewKeysOfTheCurrentInputAgain(db: DatabaseSync, prs: readonly ReviewedPr[]): string[] {
  return reviewsOfTheCurrentInputAgain(db, prs).map(row => row.task_key)
}

function underCurrentInput(row: ReviewRow): boolean {
  const current: QueuedTask = { queue: 'review', cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined, input: reviewInputOf(row.body_sha, row.card_body) }
  return current.input === undefined || keyOf(current) === row.task_key
}

function mayBeRequeued(db: DatabaseSync, ts: string, row: RequeueRow, mayRequeue: MayRequeue): boolean {
  const continuesADecision = row.cause === undefined && answerDecisionOfKey(row.queue, row.task_key) !== undefined
  return continuesADecision || mayRequeue(db, ts, { queue: row.queue, pr: row.pr, head: row.head })
}

export function requeueTask(db: DatabaseSync, ts: string, row: RequeueRow, mayRequeue: MayRequeue): boolean {
  if (!mayBeRequeued(db, ts, row, mayRequeue))
    return false
  const event = taskEvent(ts, TASK_REQUEUED, identityOfRow(row), row.failure, undefined, row.fault === true)
  return written(db, row.cause === undefined ? event : { ...event, payload: { ...event.payload as Record<string, unknown>, cause: row.cause } })
}

export function deriveQueues(db: DatabaseSync, ts: string, sources: readonly QueueSource[], mayRequeue: MayRequeue): Derived {
  const derived: Derived = { queued: [], superseded: [] }
  for (const source of sources) {
    for (const row of source.requeue?.(db, ts) ?? []) {
      if (requeueTask(db, ts, row, mayRequeue))
        derived.queued.push(row.task_key)
    }
  }
  for (const source of sources)
    source.settle?.(db, ts)
  for (const source of sources) {
    for (const task of source.enqueue?.(db, ts) ?? []) {
      if (queueTask(db, ts, task))
        derived.queued.push(keyOf(task))
    }
  }
  return derived
}

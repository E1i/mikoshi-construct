import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Queue, TaskIdentity } from './identifiers.js'
import type { Fold, StoredEvent } from './stored.js'
import { INTAKE_EVENT } from '../../src/commands/intake/confirm.js'
import { INTAKE_MOVE_EVENT } from '../../src/commands/intake/move.js'
import { MERGE_DONE, REVIEW_RECORDED } from './card-automaton.js'
import { appendEvent, inTransaction } from './db.js'
import { generationOfKey, QUEUES, reviewInputOf, reviewInputOfKey, taskKey } from './identifiers.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, ownerInbox, ownerQuestionAnswered } from './inbox.js'
import { CARD_ADMITTED, launchCandidates } from './launch-candidates.js'
import { unspentShardsOf } from './shards.js'
import { MAIN_BRANCH } from './snapshot.js'
import { payloadOf, reject, storedByKey } from './stored.js'

export const TASK_ENQUEUED = 'task.enqueued'
export const TASK_SUPERSEDED = 'task.superseded'
export const TASK_REQUEUED = 'task.requeued'
export const QUEUE_ACTOR = 'policy'
export const CARD_CLOSED = 'card.closed'
export const BOARD_ALARM = 'board.alarm'
export const FAILURES_TO_STOP = 3
export const REVIEW_ROUNDS = 3

export const QUEUED = 'queued'
export const LEASED = 'leased'
export const WITHDRAWN = 'withdrawn'
export const COMPLETED = 'completed'
export const STOPPED = 'stopped'
const SUPERSEDED = 'superseded'
const FAULT = 'fault'
const REQUEUABLE = new Set([STOPPED, WITHDRAWN, SUPERSEDED])
const REQUEUABLE_ANSWER = new Set([...REQUEUABLE, COMPLETED])
const NO_CARD_TREE = 'no_card_tree'

function cardBodyShaOf(card: string): string {
  return `(
    SELECT json_extract(intake.payload, '$.bodySha') FROM events AS intake
    WHERE intake.legacy = 1 AND intake.card_id = ${card} AND intake.type IN ('${INTAKE_EVENT}', '${INTAKE_MOVE_EVENT}')
      AND json_type(intake.payload, '$.bodySha') = 'text'
    ORDER BY intake.id DESC LIMIT 1
  )`
}

const REVIEWED_UNDER_AN_INPUT = `EXISTS (
  SELECT 1 FROM tasks AS reviewed WHERE reviewed.queue = 'review' AND reviewed.pr = prs.pr AND reviewed.head = prs.head AND reviewed.task_key LIKE '%:pr-body-%'
)`

const A_REVIEW_UNDER_A_PLAIN_KEY = `EXISTS (
  SELECT 1 FROM tasks AS plain WHERE plain.queue = 'review' AND plain.pr = prs.pr AND plain.head = prs.head
    AND plain.state != '${SUPERSEDED}' AND plain.task_key NOT LIKE '%:pr-body-%'
)`

const REVIEW_CANDIDATES = `
  SELECT pr, card_id, head, body_sha, ${cardBodyShaOf('prs.card_id')} AS card_body FROM prs
  WHERE state = 'open' AND ci = 'green' AND card_id IS NOT NULL AND head IS NOT NULL
    AND (verdict_on_head IS NULL OR (verdict_on_head = 'changes' AND body_sha IS NOT NULL AND ${REVIEWED_UNDER_AN_INPUT}))
    AND NOT ${A_REVIEW_UNDER_A_PLAIN_KEY}
  ORDER BY pr
`

const SUPERSEDED_REVIEWS_ON_THE_CURRENT_HEAD = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure, prs.body_sha, ${cardBodyShaOf('tasks.card_id')} AS card_body FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'review' AND tasks.state = '${SUPERSEDED}' AND tasks.head = prs.head AND prs.state = 'open'
    AND prs.ci = 'green' AND (prs.verdict_on_head IS NULL OR prs.verdict_on_head = 'changes')
    AND prs.body_sha IS NOT NULL AND tasks.task_key LIKE '%:pr-body-%'
    AND NOT EXISTS (SELECT 1 FROM tasks AS live WHERE live.queue = 'review' AND live.pr = tasks.pr AND live.state IN ('queued', 'leased'))
  ORDER BY tasks.task_key
`

const REVIEWS_OF_AN_OLD_INPUT = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, prs.body_sha, ${cardBodyShaOf('tasks.card_id')} AS card_body FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'review' AND tasks.state IN ('queued', 'leased') AND tasks.head = prs.head
    AND prs.body_sha IS NOT NULL AND tasks.task_key LIKE '%:pr-body-%'
  ORDER BY tasks.task_key
`

const LATEST_ADMISSION_DEPENDS = `
  SELECT depends.value AS card_id FROM json_each((
    SELECT admitted.payload FROM events AS admitted
    WHERE admitted.legacy = 0 AND admitted.type = '${CARD_ADMITTED}' AND admitted.card_id = prs.card_id
    ORDER BY admitted.id DESC LIMIT 1
  ), '$.depends') AS depends
  WHERE depends.type = 'integer'
`

const A_DEPENDENCY_UNMERGED = `EXISTS (
  SELECT 1 FROM (${LATEST_ADMISSION_DEPENDS}) AS dependency
  WHERE NOT EXISTS (SELECT 1 FROM events AS done WHERE done.type = '${MERGE_DONE}' AND done.legacy = 0 AND done.card_id = dependency.card_id)
    AND NOT EXISTS (SELECT 1 FROM prs AS merged WHERE merged.card_id = dependency.card_id AND merged.state = 'merged')
    AND NOT EXISTS (SELECT 1 FROM events AS legacy WHERE legacy.type = 'merge' AND legacy.legacy = 1 AND legacy.card_id = dependency.card_id)
)`

const MERGE_CANDIDATES = `
  SELECT pr, card_id, head FROM prs
  WHERE state = 'open' AND base = '${MAIN_BRANCH}' AND ci = 'green' AND verdict_on_head = 'pass' AND mergeable = 'clean' AND draft = 0 AND card_id IS NOT NULL AND head IS NOT NULL
    AND NOT ${A_DEPENDENCY_UNMERGED}
  ORDER BY pr
`

const UPDATE_CANDIDATES = `
  SELECT pr, card_id, head, verdict_on_head FROM prs
  WHERE state = 'open' AND base = '${MAIN_BRANCH}' AND mergeable = 'behind' AND draft = 0 AND card_id IS NOT NULL AND head IS NOT NULL
  ORDER BY pr
`

const LAST_MECHANICS = `SELECT sha, event_id FROM mains WHERE touches_mechanics = 1 ORDER BY event_id DESC LIMIT 1`

const RESTART_TARGETS = `
  WITH mechanics AS (${LAST_MECHANICS}), readings AS (
    SELECT chains.dir, chains.card_id, chains.sha, chains.state, mechanics.sha AS mechanics_sha,
      mechanics.sha IS NOT NULL AND chains.sha NOT IN (SELECT sha FROM mains WHERE event_id >= mechanics.event_id) AS behind
    FROM chains LEFT JOIN mechanics ON 1
  )
  SELECT dir, card_id, CASE WHEN behind THEN mechanics_sha ELSE sha END AS head FROM readings
  WHERE state != 'stopped' AND (behind OR state = 'fault')
`

const RESTART_CANDIDATES = `SELECT NULL AS pr, card_id, head FROM (${RESTART_TARGETS}) ORDER BY dir`

const CLOSE_CANDIDATES = `
  SELECT pr, card_id, head FROM prs
  WHERE state = 'merged' AND card_id IS NOT NULL AND head IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM events WHERE events.type = '${CARD_CLOSED}' AND events.card_id = prs.card_id)
  ORDER BY pr
`

export const QUESTION_AGENT = 'question.agent'
export const QUESTION_OWNER = 'question.owner'
const CARD_TURNS = `'${CARD_STOPPED}', '${CARD_ANSWERED}', '${CARD_STARTED}'`

export function latestTurnOf(card: string): string {
  return `(SELECT id FROM events AS turn WHERE turn.card_id = ${card} AND turn.legacy = 0 AND turn.type IN (${CARD_TURNS}) ORDER BY turn.id DESC LIMIT 1)`
}

const QUESTION_CANDIDATES = `
  SELECT stop.card_id, coalesce(stop.pr, cards.pr) AS pr, coalesce(prs.head, stop.head) AS head, stop.id AS stop FROM events AS stop
  LEFT JOIN cards ON cards.card_id = stop.card_id
  LEFT JOIN prs ON prs.pr = coalesce(stop.pr, cards.pr)
  WHERE stop.type = '${CARD_STOPPED}' AND stop.legacy = 0 AND stop.card_id IS NOT NULL
    AND json_extract(stop.payload, '$.reason') = '${QUESTION_AGENT}'
    AND stop.id = ${latestTurnOf('stop.card_id')}
    AND (prs.pr IS NULL OR prs.state = 'open')
  ORDER BY stop.card_id
`

const AN_OPEN_QUESTION = `(
  json_extract(stop.payload, '$.reason') = '${QUESTION_AGENT}'
  OR (json_extract(stop.payload, '$.reason') = '${QUESTION_OWNER}' AND NOT ${ownerQuestionAnswered('stop')})
)`

function answerCandidatesWhere(condition: string): string {
  return `
  SELECT pr, card_id, head FROM prs
  WHERE state = 'open' AND ${condition} AND card_id IS NOT NULL AND head IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM events AS stop WHERE stop.id = ${latestTurnOf('prs.card_id')}
        AND stop.type = '${CARD_STOPPED}' AND ${AN_OPEN_QUESTION}
    )
  ORDER BY pr
`
}

const CHANGES_CANDIDATES = answerCandidatesWhere(`verdict_on_head = 'changes'`)

const RED_CI_CANDIDATES = answerCandidatesWhere(`ci = 'red'`)

const DIRTY_CANDIDATES = answerCandidatesWhere(`base = '${MAIN_BRANCH}' AND mergeable = 'dirty' AND draft = 0`)

interface Candidate {
  pr: number | null
  card_id: number
  head: string | null
  verdict_on_head?: string | null
  stop?: number | null
  body_sha?: string | null
  card_body?: unknown
}

const CHANGES_ROUNDS_OF_A_PR = `
  SELECT count(*) AS rounds FROM events
  WHERE type = '${REVIEW_RECORDED}' AND legacy = 0 AND pr = ? AND json_extract(payload, '$.verdict') = 'changes'
`

export function changesRoundsOf(db: DatabaseSync, pr: number): number {
  return Number((db.prepare(CHANGES_ROUNDS_OF_A_PR).get(pr) as { rounds: number }).rounds)
}

const ROUND_LIMITED: readonly Queue[] = ['review', 'answer', 'merge']

function outOfRounds(db: DatabaseSync, queue: Queue, pr: number | null): boolean {
  return ROUND_LIMITED.includes(queue) && pr !== null && changesRoundsOf(db, pr) >= REVIEW_ROUNDS
}

type Admits = (row: Candidate) => boolean

const everyRow: Admits = () => true

function passOrWaitingForOwner(db: DatabaseSync): Admits {
  const waiting = new Set(ownerInbox(db).map(line => line.card_id))
  return row => row.verdict_on_head === 'pass' || waiting.has(row.card_id)
}

function candidates(db: DatabaseSync): [Queue, string, Admits][] {
  return [
    ['review', REVIEW_CANDIDATES, everyRow],
    ['update', UPDATE_CANDIDATES, passOrWaitingForOwner(db)],
    ['merge', MERGE_CANDIDATES, everyRow],
    ['restart', RESTART_CANDIDATES, everyRow],
    ['close', CLOSE_CANDIDATES, everyRow],
    ['answer', QUESTION_CANDIDATES, everyRow],
    ['answer', CHANGES_CANDIDATES, everyRow],
    ['answer', RED_CI_CANDIDATES, everyRow],
    ['answer', DIRTY_CANDIDATES, everyRow],
  ]
}

const TASKS_OF_AN_OLD_HEAD = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head FROM tasks JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.state IN ('${QUEUED}', '${LEASED}') AND tasks.head IS NOT NULL AND tasks.head != prs.head
  UNION
  SELECT task_key, queue, card_id, pr, head FROM tasks
  WHERE queue = 'restart' AND state IN ('${QUEUED}', '${LEASED}')
    AND head NOT IN (SELECT targets.head FROM (${RESTART_TARGETS}) AS targets WHERE targets.card_id = tasks.card_id)
  ORDER BY task_key
`

const CARD_TREE_CAN_BE_BROUGHT_UP = `(
  EXISTS (SELECT 1 FROM prs AS open WHERE open.card_id = tasks.card_id AND open.state = 'open')
  OR EXISTS (
    SELECT 1 FROM events AS start WHERE start.card_id = tasks.card_id
      AND ((start.type = '${CARD_STARTED}' AND start.legacy = 0) OR (start.type = 'path' AND start.legacy = 1))
      AND json_type(start.payload, '$.worktree') = 'text' AND json_type(start.payload, '$.branch') = 'text'
  )
)`

const STOPPED_ON_NO_CARD_TREE = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, failure.id AS failure FROM tasks
  JOIN events AS failure ON failure.id = tasks.event_id
  LEFT JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'answer' AND tasks.state = '${STOPPED}' AND json_extract(failure.payload, '$.reason') = '${NO_CARD_TREE}'
    AND (tasks.pr IS NULL OR (prs.state = 'open' AND prs.head = tasks.head))
    AND ${CARD_TREE_CAN_BE_BROUGHT_UP}
  ORDER BY tasks.task_key
`

const WITHDRAWN_MERGES_A_LATER_SHARD_NAMES = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.event_id AS failure FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.queue = 'merge' AND tasks.state = '${WITHDRAWN}' AND prs.state = 'open' AND prs.head = tasks.head
    AND NOT EXISTS (SELECT 1 FROM events AS requeued WHERE requeued.type = '${TASK_REQUEUED}' AND json_extract(requeued.payload, '$.task_key') = tasks.task_key)
    AND EXISTS (SELECT 1 FROM (${unspentShardsOf('tasks.card_id', 'tasks.pr')}) AS shard WHERE shard.event_id > tasks.event_id)
  ORDER BY tasks.task_key
`

const ANSWERS_WHOSE_STOP_NO_LONGER_HOLDS = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head, tasks.failures, stop.id AS failure,
    json_extract(stop.payload, '$.reason') = '${FAULT}' AS fault FROM tasks
  JOIN prs ON prs.pr = tasks.pr
  JOIN events AS stop ON stop.dedupe_key = '${CARD_STOPPED}:' || tasks.task_key || ':' || tasks.lease_gen
  WHERE tasks.queue = 'answer' AND tasks.state = '${COMPLETED}' AND tasks.task_key NOT LIKE '%:stop-%'
    AND prs.state = 'open' AND prs.head = tasks.head
    AND stop.id = ${latestTurnOf('tasks.card_id')}
    AND json_extract(stop.payload, '$.reason') IN ('${FAULT}', '${QUESTION_OWNER}') AND NOT ${AN_OPEN_QUESTION}
  ORDER BY tasks.task_key
`

interface TaskRow {
  task_key: string
  queue: Queue
  card_id: number
  pr: number | null
  head: string | null
}

interface StoppedRow extends TaskRow {
  failure: number
}

interface ReviewRow extends TaskRow {
  body_sha: string
  card_body: unknown
}

type SupersededReviewRow = ReviewRow & StoppedRow

interface StoppedAnswerRow extends StoppedRow {
  failures: number
  fault: number
}

interface QueuedTask extends TaskIdentity {
  stop?: number
}

const STOP_SUFFIX = /:stop-([1-9]\d*)$/

function keyOf(task: QueuedTask): string {
  const key = taskKey(task)
  return task.stop === undefined ? key : `${key}:stop-${task.stop}`
}

function stopIn(key: unknown): number | undefined {
  const match = typeof key === 'string' ? STOP_SUFFIX.exec(key) : null
  return match === null ? undefined : Number(match[1])
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
  const input = queue === 'review' ? reviewInputOfKey(payload.task_key) : undefined
  if (input !== undefined && (event.pr === null || event.head === null))
    reject(`${event.type} of a review input needs a pr and a head`)
  const key = keyOf({ queue, cardId, pr: event.pr ?? undefined, head: event.head ?? undefined, generation, stop, input })
  if (payload.task_key !== key)
    reject(`task_key ${String(payload.task_key)} is not ${key}`)
  return { key, queue }
}

function taskRow(db: DatabaseSync, key: string): { state: string } | undefined {
  return db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(key) as { state: string } | undefined
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
  const requeuable = queue === 'answer' ? REQUEUABLE_ANSWER : REQUEUABLE
  if (!requeuable.has(task.state))
    reject(`task ${key} is ${task.state}, not ${[...requeuable].join(' or ')}`)
  const failures = payloadOf(event).fault === true ? 'failures + 1' : '0'
  db.prepare(`UPDATE tasks SET state = ?, failures = ${failures}, event_id = ? WHERE task_key = ?`).run(QUEUED, event.id, key)
}

export const TASK_FOLDS: Record<string, Fold> = {
  [TASK_ENQUEUED]: foldEnqueued,
  [TASK_SUPERSEDED]: foldSuperseded,
  [TASK_REQUEUED]: foldRequeued,
}

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

function appended(db: DatabaseSync, event: BusEvent): boolean {
  if (!appendEvent(db, event))
    return false
  TASK_FOLDS[event.type]!(db, storedByKey(db, event.dedupeKey))
  return true
}

function written(db: DatabaseSync, event: BusEvent): boolean {
  return inTransaction(db, () => appended(db, event))
}

export function queueTaskWithin(db: DatabaseSync, ts: string, task: QueuedTask): boolean {
  return appended(db, taskEvent(ts, TASK_ENQUEUED, task))
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

function identity(row: TaskRow): QueuedTask {
  const plain = { queue: row.queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined }
  const input = row.queue === 'review' ? reviewInputOfKey(row.task_key) : undefined
  return { ...plain, generation: generationOfKey(row.task_key, plain), stop: stopIn(row.task_key), input }
}

export function cardBodyShaOfCard(db: DatabaseSync, cardId: number): string | null {
  const row = db.prepare(`SELECT ${cardBodyShaOf('?')} AS card_body`).get(cardId) as { card_body: unknown }
  return typeof row.card_body === 'string' ? row.card_body : null
}

function reviewsOfAnOldInput(db: DatabaseSync): ReviewRow[] {
  return (db.prepare(REVIEWS_OF_AN_OLD_INPUT).all() as unknown as ReviewRow[]).filter(row => !underCurrentInput(row))
}

export function reviewKeysOfAnOldInput(db: DatabaseSync): string[] {
  return reviewsOfAnOldInput(db).map(row => row.task_key)
}

function reviewsOfTheCurrentInputAgain(db: DatabaseSync): SupersededReviewRow[] {
  return (db.prepare(SUPERSEDED_REVIEWS_ON_THE_CURRENT_HEAD).all() as unknown as SupersededReviewRow[]).filter(underCurrentInput)
}

export function reviewKeysOfTheCurrentInputAgain(db: DatabaseSync): string[] {
  return reviewsOfTheCurrentInputAgain(db).map(row => row.task_key)
}

function underCurrentInput(row: ReviewRow): boolean {
  const current: QueuedTask = { queue: 'review', cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined, input: reviewInputOf(row.body_sha, row.card_body) }
  return current.input === undefined || keyOf(current) === row.task_key
}

function requeueTask(db: DatabaseSync, ts: string, row: StoppedRow, fault = false): boolean {
  if (outOfRounds(db, row.queue, row.pr))
    return false
  return written(db, taskEvent(ts, TASK_REQUEUED, identity(row), row.failure, undefined, fault))
}

function alarmed(db: DatabaseSync, ts: string, row: StoppedAnswerRow): void {
  const failures = row.failures + 1
  const detail = `${failures} failures in a row on ${row.task_key}, the last a ${FAULT} stop`
  appendEvent(db, { ts, type: BOARD_ALARM, actor: QUEUE_ACTOR, cardId: row.card_id, pr: row.pr, head: row.head, dedupeKey: `${BOARD_ALARM}:${row.task_key}`, payload: { task_key: row.task_key, reason: FAULT, failures, detail }, legacy: false })
}

function setAgainAfterItsStop(db: DatabaseSync, ts: string, row: StoppedAnswerRow): boolean {
  const fault = row.fault === 1
  if (fault && row.failures + 1 >= FAILURES_TO_STOP) {
    alarmed(db, ts, row)
    return false
  }
  return requeueTask(db, ts, row, fault)
}

export function deriveQueues(db: DatabaseSync, ts: string): Derived {
  const derived: Derived = { queued: [], superseded: [] }
  for (const row of db.prepare(TASKS_OF_AN_OLD_HEAD).all() as unknown as TaskRow[]) {
    if (supersedeTask(db, ts, identity(row)))
      derived.superseded.push(row.task_key)
  }
  for (const row of reviewsOfAnOldInput(db)) {
    if (supersedeTask(db, ts, identity(row)))
      derived.superseded.push(row.task_key)
  }
  for (const query of [STOPPED_ON_NO_CARD_TREE, WITHDRAWN_MERGES_A_LATER_SHARD_NAMES]) {
    for (const row of db.prepare(query).all() as unknown as StoppedRow[]) {
      if (requeueTask(db, ts, row))
        derived.queued.push(row.task_key)
    }
  }
  for (const row of reviewsOfTheCurrentInputAgain(db)) {
    if (requeueTask(db, ts, row))
      derived.queued.push(row.task_key)
  }
  for (const row of db.prepare(ANSWERS_WHOSE_STOP_NO_LONGER_HOLDS).all() as unknown as StoppedAnswerRow[]) {
    if (setAgainAfterItsStop(db, ts, row))
      derived.queued.push(row.task_key)
  }
  for (const [queue, query, admits] of candidates(db)) {
    for (const row of (db.prepare(query).all() as unknown as Candidate[]).filter(admits).filter(row => !outOfRounds(db, queue, row.pr))) {
      const input = row.body_sha === undefined ? undefined : reviewInputOf(row.body_sha, row.card_body)
      const task: QueuedTask = { queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined, stop: row.stop ?? undefined, input }
      if (queueTask(db, ts, task))
        derived.queued.push(keyOf(task))
    }
  }
  for (const { cardId, generation } of launchCandidates(db)) {
    const task: QueuedTask = { queue: 'launch', cardId, generation }
    if (queueTask(db, ts, task))
      derived.queued.push(keyOf(task))
  }
  return derived
}

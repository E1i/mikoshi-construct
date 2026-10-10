import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Queue, TaskIdentity } from './identifiers.js'
import type { Fold, StoredEvent } from './stored.js'
import { appendEvent, inTransaction } from './db.js'
import { QUEUES, taskKey } from './identifiers.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, ownerInbox } from './inbox.js'
import { MAIN_BRANCH } from './snapshot.js'
import { payloadOf, reject, storedByKey } from './stored.js'

export const TASK_ENQUEUED = 'task.enqueued'
export const TASK_SUPERSEDED = 'task.superseded'
export const QUEUE_ACTOR = 'policy'

export const QUEUED = 'queued'
export const LEASED = 'leased'
const SUPERSEDED = 'superseded'

const REVIEW_CANDIDATES = `
  SELECT pr, card_id, head FROM prs
  WHERE state = 'open' AND ci = 'green' AND verdict_on_head IS NULL AND card_id IS NOT NULL AND head IS NOT NULL
  ORDER BY pr
`

const MERGE_CANDIDATES = `
  SELECT pr, card_id, head FROM prs
  WHERE state = 'open' AND base = '${MAIN_BRANCH}' AND ci = 'green' AND verdict_on_head = 'pass' AND mergeable = 'clean' AND draft = 0 AND card_id IS NOT NULL AND head IS NOT NULL
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

const CHANGES_CANDIDATES = `
  SELECT pr, card_id, head FROM prs
  WHERE state = 'open' AND verdict_on_head = 'changes' AND card_id IS NOT NULL AND head IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM events AS stop WHERE stop.id = ${latestTurnOf('prs.card_id')}
        AND stop.type = '${CARD_STOPPED}' AND json_extract(stop.payload, '$.reason') IN ('${QUESTION_OWNER}', '${QUESTION_AGENT}')
    )
  ORDER BY pr
`

interface Candidate {
  pr: number | null
  card_id: number
  head: string | null
  verdict_on_head?: string | null
  stop?: number | null
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
    ['answer', QUESTION_CANDIDATES, everyRow],
    ['answer', CHANGES_CANDIDATES, everyRow],
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

interface TaskRow {
  task_key: string
  queue: Queue
  card_id: number
  pr: number | null
  head: string | null
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
  const stop = queue === 'answer' ? stopIn(payload.task_key) : undefined
  const key = keyOf({ queue, cardId, pr: event.pr ?? undefined, head: event.head ?? undefined, stop })
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

export const TASK_FOLDS: Record<string, Fold> = {
  [TASK_ENQUEUED]: foldEnqueued,
  [TASK_SUPERSEDED]: foldSuperseded,
}

function taskEvent(ts: string, type: string, task: QueuedTask): BusEvent {
  const key = keyOf(task)
  return { ts, type, actor: QUEUE_ACTOR, cardId: task.cardId, pr: task.pr ?? null, head: task.head ?? null, dedupeKey: `${type}:${key}`, payload: { task_key: key, queue: task.queue }, legacy: false }
}

function written(db: DatabaseSync, event: BusEvent): boolean {
  return inTransaction(db, () => {
    if (!appendEvent(db, event))
      return false
    TASK_FOLDS[event.type]!(db, storedByKey(db, event.dedupeKey))
    return true
  })
}

export function queueTask(db: DatabaseSync, ts: string, task: QueuedTask): boolean {
  return written(db, taskEvent(ts, TASK_ENQUEUED, task))
}

export function supersedeTask(db: DatabaseSync, ts: string, task: QueuedTask): boolean {
  return written(db, taskEvent(ts, TASK_SUPERSEDED, task))
}

function identity(row: TaskRow): QueuedTask {
  return { queue: row.queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined, stop: stopIn(row.task_key) }
}

export function deriveQueues(db: DatabaseSync, ts: string): Derived {
  const derived: Derived = { queued: [], superseded: [] }
  for (const row of db.prepare(TASKS_OF_AN_OLD_HEAD).all() as unknown as TaskRow[]) {
    if (supersedeTask(db, ts, identity(row)))
      derived.superseded.push(row.task_key)
  }
  for (const [queue, query, admits] of candidates(db)) {
    for (const row of (db.prepare(query).all() as unknown as Candidate[]).filter(admits)) {
      const task: QueuedTask = { queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined, stop: row.stop ?? undefined }
      if (queueTask(db, ts, task))
        derived.queued.push(keyOf(task))
    }
  }
  return derived
}

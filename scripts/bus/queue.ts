import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from './db.js'
import type { Queue, TaskIdentity } from './identifiers.js'
import type { Fold, StoredEvent } from './stored.js'
import { appendEvent, inTransaction } from './db.js'
import { QUEUES, taskKey } from './identifiers.js'
import { ownerInbox } from './inbox.js'
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

interface Candidate {
  pr: number
  card_id: number
  head: string
  verdict_on_head?: string | null
}

type Admits = (row: Candidate) => boolean

const everyRow: Admits = () => true

function passOrWaitingForOwner(db: DatabaseSync): Admits {
  const waiting = new Set(ownerInbox(db).map(line => line.card_id))
  return row => row.verdict_on_head === 'pass' || waiting.has(row.card_id)
}

function candidates(db: DatabaseSync): [Queue, string, Admits][] {
  return [['review', REVIEW_CANDIDATES, everyRow], ['update', UPDATE_CANDIDATES, passOrWaitingForOwner(db)], ['merge', MERGE_CANDIDATES, everyRow]]
}

const TASKS_OF_AN_OLD_HEAD = `
  SELECT tasks.task_key, tasks.queue, tasks.card_id, tasks.pr, tasks.head FROM tasks JOIN prs ON prs.pr = tasks.pr
  WHERE tasks.state IN ('${QUEUED}', '${LEASED}') AND tasks.head IS NOT NULL AND tasks.head != prs.head
  ORDER BY tasks.task_key
`

interface TaskRow {
  task_key: string
  queue: Queue
  card_id: number
  pr: number | null
  head: string | null
}

export interface Derived {
  queued: string[]
  superseded: string[]
}

export function identityOf(event: StoredEvent): { key: string, queue: Queue } {
  const payload = payloadOf(event)
  const queue = QUEUES.find(each => each === payload.queue) ?? reject(`queue is not one of ${QUEUES.join(' | ')}`)
  const cardId = event.card_id ?? reject(`${event.type} needs a card_id`)
  const key = taskKey({ queue, cardId, pr: event.pr ?? undefined, head: event.head ?? undefined })
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

function taskEvent(ts: string, type: string, task: TaskIdentity): BusEvent {
  const key = taskKey(task)
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

export function queueTask(db: DatabaseSync, ts: string, task: TaskIdentity): boolean {
  return written(db, taskEvent(ts, TASK_ENQUEUED, task))
}

export function supersedeTask(db: DatabaseSync, ts: string, task: TaskIdentity): boolean {
  return written(db, taskEvent(ts, TASK_SUPERSEDED, task))
}

function identity(row: TaskRow): TaskIdentity {
  return { queue: row.queue, cardId: row.card_id, pr: row.pr ?? undefined, head: row.head ?? undefined }
}

export function deriveQueues(db: DatabaseSync, ts: string): Derived {
  const derived: Derived = { queued: [], superseded: [] }
  for (const row of db.prepare(TASKS_OF_AN_OLD_HEAD).all() as unknown as TaskRow[]) {
    if (supersedeTask(db, ts, identity(row)))
      derived.superseded.push(row.task_key)
  }
  for (const [queue, query, admits] of candidates(db)) {
    for (const row of (db.prepare(query).all() as unknown as Candidate[]).filter(admits)) {
      const task: TaskIdentity = { queue, cardId: row.card_id, pr: row.pr, head: row.head }
      if (queueTask(db, ts, task))
        derived.queued.push(taskKey(task))
    }
  }
  return derived
}

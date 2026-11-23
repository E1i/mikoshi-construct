import type { DatabaseSync } from 'node:sqlite'
import type { Queue } from '../../core/identifiers.js'
import type { RequestContext, RequestExecutor } from './context.js'
import type { QueueTaskRow } from './reach.js'
import type { Executed, RequestPayload } from './request.js'
import { EITHER_JOURNAL, events } from '../../core/events-query.js'
import { TASK_WITHDRAWN } from '../../core/events.js'
import * as tasks from '../../core/tasks-query.js'
import { answersWithdrawnByAClosedHold, appendedAndReduced, appendEvent, CARD_HELD, CARD_RELEASED, cardIdOf, holdLayersOf, holdThatStays, inTransaction, QUEUE_ACTOR, queueAgain, QUEUED, WITHDRAWN } from './reach.js'
import { text } from './request.js'

const WITHDRAWN_BY_A_HOLD = `${TASK_WITHDRAWN}:${CARD_HELD}:`

function queueRowOf(row: tasks.TaskRow): QueueTaskRow {
  return { task_key: row.task_key, queue: row.queue as Queue, card_id: row.card_id, pr: row.pr, head: row.head, state: row.state }
}

function withdrawQueuedTasks(db: DatabaseSync, ts: string, cardId: number, request: number): string[] {
  const queued = tasks.ofCard(db, cardId, { state: QUEUED })
  for (const row of queued)
    appendedAndReduced(db, { ts, type: TASK_WITHDRAWN, actor: QUEUE_ACTOR, cardId, pr: row.pr, head: row.head, dedupeKey: `${WITHDRAWN_BY_A_HOLD}request-${request}:${row.task_key}`, payload: { task_key: row.task_key, queue: row.queue }, legacy: false })
  return queued.map(row => row.task_key)
}

function withdrawnByTheClosedHold(db: DatabaseSync, cardId: number, opened: number | null): QueueTaskRow[] {
  if (opened === null || holdLayersOf(db, cardId).opened !== null)
    return []
  const rows = tasks.ofCard(db, cardId, { state: WITHDRAWN, after: opened })
  const byAHold = new Set(events(db, { types: [TASK_WITHDRAWN], ids: rows.map(row => row.event_id), legacy: EITHER_JOURNAL })
    .filter(event => event.dedupe_key.startsWith(WITHDRAWN_BY_A_HOLD))
    .map(event => event.id))
  return rows.filter(row => byAHold.has(row.event_id)).map(queueRowOf)
}

function requeuedOnRelease(db: DatabaseSync, cardId: number, opened: number | null): QueueTaskRow[] {
  const answers = answersWithdrawnByAClosedHold(db, cardId, opened)
  const keys = new Set(answers.map(task => task.task_key))
  return [...answers, ...withdrawnByTheClosedHold(db, cardId, opened).filter(task => !keys.has(task.task_key))]
}

export function holdFor(context: RequestContext, request: number, payload: RequestPayload, type: typeof CARD_HELD | typeof CARD_RELEASED): Executed {
  const cardId = cardIdOf(payload.card)
  const reason = text(payload.reason)
  if (cardId === null || (type === CARD_HELD && reason === null))
    return { done: false, why: type === CARD_HELD ? 'hold needs a card and the reason the owner holds it' : 'release names no card' }
  const ts = context.now()
  const { requeued, withdrawn } = inTransaction(context.db, () => {
    const opened = holdLayersOf(context.db, cardId).opened
    appendEvent(context.db, { ts, type, actor: QUEUE_ACTOR, cardId, pr: null, head: null, dedupeKey: `${type}:request-${request}`, payload: { request, ...(reason === null ? {} : { reason }) }, legacy: false })
    if (type === CARD_HELD)
      return { requeued: [], withdrawn: withdrawQueuedTasks(context.db, ts, cardId, request) }
    const again = requeuedOnRelease(context.db, cardId, opened)
    again.forEach(task => queueAgain(context.db, ts, task, request, `request-${request}`))
    return { requeued: again.map(task => task.task_key), withdrawn: [] }
  })
  const stays = type === CARD_RELEASED ? holdThatStays(context.db, cardId) : null
  const withdrawnLine = withdrawn.length === 0 ? '' : `; withdrawn: ${withdrawn.join(', ')}`
  return { done: true, why: `${type} #${cardId}${reason === null ? '' : `: ${reason}`}${withdrawnLine}${stays ?? (requeued.length === 0 ? '' : `; queued again: ${requeued.join(', ')}`)}` }
}

export const execute: RequestExecutor = (context, request, payload) => holdFor(context, request, payload, CARD_HELD)

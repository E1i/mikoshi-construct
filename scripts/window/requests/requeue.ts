import type { DatabaseSync } from 'node:sqlite'
import type { TaskRow } from '../../core/tasks-query.js'
import type { RequestContext, RequestExecutor } from './context.js'
import type { QueueTaskRow } from './reach.js'
import type { Executed, RequestPayload } from './request.js'
import { EITHER_JOURNAL, events, latest } from '../../core/events-query.js'
import * as prs from '../../core/pr-readings.js'
import * as tasks from '../../core/tasks-query.js'
import { BOARD_ALARM, closedByRounds, FAILURES_TO_STOP, inTransaction, LEASED, queueAgain, QUEUED, TASK_REQUEUED } from './reach.js'
import { messageOf, text } from './request.js'

function requeuesOnRequestSince(db: DatabaseSync, alarm: number, key: string): number {
  return events(db, { types: [TASK_REQUEUED], since: alarm, task: key, legacy: EITHER_JOURNAL }).filter(row => Number.isInteger(row.data?.request)).length
}

function queueRowOf(task: TaskRow): QueueTaskRow {
  return { task_key: task.task_key, queue: task.queue as QueueTaskRow['queue'], card_id: task.card_id, pr: task.pr, head: task.head, state: task.state }
}

const DIRTY_TREE_CAUSE = /has uncommitted changes$/

export const CONTINUED_FROM_THE_TREE = 'the node that takes it next continues from the tree as it stands, writing nothing in it first'

export function requeue(context: RequestContext, request: number, payload: RequestPayload, owner = false): Executed {
  const { db } = context
  const key = text(payload.task_key)
  if (key === null)
    return { done: false, why: 'requeue names no task_key' }
  const alarm = owner ? undefined : latest(db, { types: [BOARD_ALARM], task: key, legacy: EITHER_JOURNAL }) ?? undefined
  if (alarm === undefined && !owner)
    return { done: false, why: `no ${BOARD_ALARM} names ${key}` }
  const stored = tasks.byKey(db, key)
  if (stored === null)
    return { done: false, why: `${key} is not a task` }
  const task = queueRowOf(stored)
  if (task.state === QUEUED || task.state === LEASED)
    return { done: false, why: `${key} is ${task.state} already` }
  if (task.pr !== null) {
    const pr = prs.ofPr(db, task.pr)
    if (pr?.state !== 'open' || pr.head !== task.head)
      return { done: false, why: `PR #${task.pr} is not open at ${task.head ?? 'its head'}; a task of its current head is derived anew` }
  }
  const ts = context.now()
  if (!owner && closedByRounds(db, ts, task.queue, task.pr, task.head))
    return { done: false, why: `PR #${task.pr} is past the review round limit of D-104` }
  const requeues = alarm === undefined ? 0 : requeuesOnRequestSince(db, alarm.id, key)
  if (requeues >= FAILURES_TO_STOP)
    return { done: false, why: `${key} was requeued ${requeues} times since ${BOARD_ALARM} ${alarm!.id}, the D-104 limit` }
  const holds = owner ? null : context.tools.causeHolds({ taskKey: key, cardId: task.card_id })
  const keepsTheTree = holds !== null && DIRTY_TREE_CAUSE.test(holds)
  if (holds !== null && !keepsTheTree)
    return { done: false, why: `the cause of ${BOARD_ALARM} ${alarm!.id} holds: ${holds}` }
  try {
    inTransaction(db, () => queueAgain(db, ts, task, request, `request-${request}`))
  }
  catch (error) {
    return { done: false, why: messageOf(error) }
  }
  const after = tasks.byKey(db, key)?.state
  if (after !== QUEUED)
    return { done: false, why: `${key} stays ${String(after)}: the bus rejected its ${TASK_REQUEUED}` }
  return { done: true, why: alarm === undefined ? `${key} queued again on the owner's word, with no ${BOARD_ALARM} and no automatic condition` : `${key} queued again after ${BOARD_ALARM} ${alarm.id}, requeue ${requeues + 1} of ${FAILURES_TO_STOP}${keepsTheTree ? `; ${CONTINUED_FROM_THE_TREE}: ${holds}` : ''}` }
}

export const execute: RequestExecutor = (context, request, payload) => requeue(context, request, payload)

import type { RequestContext, RequestExecutor } from './context.js'
import type { QueueTaskRow } from './reach.js'
import type { Executed, RequestPayload } from './request.js'
import { BOARD_ALARM, closedByRounds, FAILURES_TO_STOP, inTransaction, LEASED, queueAgain, QUEUED, TASK_REQUEUED } from './reach.js'
import { messageOf, text } from './request.js'

const LAST_ALARM = `SELECT id FROM events WHERE type = '${BOARD_ALARM}' AND json_extract(payload, '$.task_key') = ? ORDER BY id DESC LIMIT 1`

const REQUEUES_SINCE = `
  SELECT count(*) AS n FROM events
  WHERE type = '${TASK_REQUEUED}' AND id > ? AND json_extract(payload, '$.task_key') = ? AND json_type(payload, '$.request') = 'integer'
`

const DIRTY_TREE_CAUSE = /has uncommitted changes$/

export function requeue(context: RequestContext, request: number, payload: RequestPayload, owner = false): Executed {
  const { db } = context
  const key = text(payload.task_key)
  if (key === null)
    return { done: false, why: 'requeue names no task_key' }
  const alarm = owner ? undefined : db.prepare(LAST_ALARM).get(key) as { id: number } | undefined
  if (alarm === undefined && !owner)
    return { done: false, why: `no ${BOARD_ALARM} names ${key}` }
  const task = db.prepare('SELECT task_key, queue, card_id, pr, head, state FROM tasks WHERE task_key = ?').get(key) as QueueTaskRow | undefined
  if (task === undefined)
    return { done: false, why: `${key} is not a task` }
  if (task.state === QUEUED || task.state === LEASED)
    return { done: false, why: `${key} is ${task.state} already` }
  if (task.pr !== null) {
    const pr = db.prepare('SELECT state, head FROM prs WHERE pr = ?').get(task.pr) as { state: string | null, head: string | null } | undefined
    if (pr?.state !== 'open' || pr.head !== task.head)
      return { done: false, why: `PR #${task.pr} is not open at ${task.head ?? 'its head'}; a task of its current head is derived anew` }
  }
  const ts = context.now()
  if (!owner && closedByRounds(db, ts, task.queue, task.pr, task.head))
    return { done: false, why: `PR #${task.pr} is past the review round limit of D-104` }
  const requeues = alarm === undefined ? 0 : Number((db.prepare(REQUEUES_SINCE).get(alarm.id, key) as { n: number }).n)
  if (requeues >= FAILURES_TO_STOP)
    return { done: false, why: `${key} was requeued ${requeues} times since ${BOARD_ALARM} ${alarm!.id}, the D-104 limit` }
  const holds = owner ? null : context.tools.causeHolds({ taskKey: key, cardId: task.card_id })
  const keepsTheTree = payload.keep_tree === true && task.queue === 'launch' && holds !== null && DIRTY_TREE_CAUSE.test(holds)
  if (holds !== null && !keepsTheTree)
    return { done: false, why: `the cause of ${BOARD_ALARM} ${alarm!.id} holds: ${holds}${task.queue === 'launch' && DIRTY_TREE_CAUSE.test(holds) ? `; a requeue with keep_tree: true launches the session on that tree as it stands, writing nothing in it` : ''}` }
  try {
    inTransaction(db, () => queueAgain(db, ts, task, request, `request-${request}`))
  }
  catch (error) {
    return { done: false, why: messageOf(error) }
  }
  const after = db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(key) as { state: string }
  if (after.state !== QUEUED)
    return { done: false, why: `${key} stays ${after.state}: the bus rejected its ${TASK_REQUEUED}` }
  return { done: true, why: alarm === undefined ? `${key} queued again on the owner's word, with no ${BOARD_ALARM} and no automatic condition` : `${key} queued again after ${BOARD_ALARM} ${alarm.id}, requeue ${requeues + 1} of ${FAILURES_TO_STOP}${keepsTheTree ? `; its session starts on the tree as it stands: ${holds}` : ''}` }
}

export const execute: RequestExecutor = (context, request, payload) => requeue(context, request, payload)

import { ownerMoveExecutor } from './owner-move.js'
import { cardBodyText, queueTaskWithin } from './reach.js'
import { LIVE_TASK_OF_CARD } from './request.js'

export const execute = ownerMoveExecutor('owner.launch', ({ context, request, cardId, ts }) => {
  const { db } = context
  const session = context.openSessionOf(cardId)
  const refusal = context.routeOf(cardId, true) ?? (cardBodyText(db, cardId) === null ? `card #${cardId} has no admitted body in the bus, so there is nothing to launch` : session === null ? null : `card #${cardId} runs the session started at event ${session}; a second session cannot share its tree`)
  if (refusal !== null)
    return { done: false, why: refusal }
  if ((db.prepare(LIVE_TASK_OF_CARD).get(cardId) as { queue: string } | undefined)?.queue !== 'launch')
    queueTaskWithin(db, ts, { queue: 'launch', cardId, generation: `owner-${request}` })
  const task = db.prepare(LIVE_TASK_OF_CARD).get(cardId) as { task_key: string, queue: string, state: string } | undefined
  return task?.queue === 'launch' ? { done: true, why: `the launch task ${task.task_key} of card #${cardId} is ${task.state}: the launch node starts it on its next lease, past its launch conditions` } : { done: false, why: `the bus rejected a launch task for card #${cardId}` }
})

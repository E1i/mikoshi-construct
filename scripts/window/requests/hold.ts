import type { RequestContext, RequestExecutor } from './context.js'
import type { Executed, RequestPayload } from './request.js'
import { answersWithdrawnByAClosedHold, appendEvent, CARD_HELD, CARD_RELEASED, cardIdOf, holdLayersOf, holdThatStays, inTransaction, QUEUE_ACTOR, queueAgain, withdrawQueuedTasksOfHeldCard } from './reach.js'
import { text } from './request.js'

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
      return { requeued: [], withdrawn: withdrawQueuedTasksOfHeldCard(context.db, ts, cardId, request) }
    const again = answersWithdrawnByAClosedHold(context.db, cardId, opened)
    again.forEach(task => queueAgain(context.db, ts, task, request, `request-${request}`))
    return { requeued: again.map(task => task.task_key), withdrawn: [] }
  })
  const stays = type === CARD_RELEASED ? holdThatStays(context.db, cardId) : null
  const withdrawnLine = withdrawn.length === 0 ? '' : `; withdrawn: ${withdrawn.join(', ')}`
  return { done: true, why: `${type} #${cardId}${reason === null ? '' : `: ${reason}`}${withdrawnLine}${stays ?? (requeued.length === 0 ? '' : `; queued again: ${requeued.join(', ')}`)}` }
}

export const execute: RequestExecutor = (context, request, payload) => holdFor(context, request, payload, CARD_HELD)

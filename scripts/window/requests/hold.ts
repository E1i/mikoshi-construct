import type { RequestContext, RequestExecutor } from './context.js'
import type { Executed, RequestPayload } from './request.js'
import { answersWithdrawnByAClosedHold, appendEvent, CARD_HELD, CARD_RELEASED, cardIdOf, holdLayersOf, holdThatStays, inTransaction, QUEUE_ACTOR, queueAgain } from './reach.js'
import { text } from './request.js'

export function holdFor(context: RequestContext, request: number, payload: RequestPayload, type: typeof CARD_HELD | typeof CARD_RELEASED): Executed {
  const cardId = cardIdOf(payload.card)
  const reason = text(payload.reason)
  if (cardId === null || (type === CARD_HELD && reason === null))
    return { done: false, why: type === CARD_HELD ? 'hold needs a card and the reason the owner holds it' : 'release names no card' }
  const ts = context.now()
  const requeued = inTransaction(context.db, () => {
    const opened = holdLayersOf(context.db, cardId).opened
    appendEvent(context.db, { ts, type, actor: QUEUE_ACTOR, cardId, pr: null, head: null, dedupeKey: `${type}:request-${request}`, payload: { request, ...(reason === null ? {} : { reason }) }, legacy: false })
    const withdrawn = type === CARD_RELEASED ? answersWithdrawnByAClosedHold(context.db, cardId, opened) : []
    withdrawn.forEach(task => queueAgain(context.db, ts, task, request, `request-${request}`))
    return withdrawn.map(task => task.task_key)
  })
  const stays = type === CARD_RELEASED ? holdThatStays(context.db, cardId) : null
  return { done: true, why: `${type} #${cardId}${reason === null ? '' : `: ${reason}`}${stays ?? (requeued.length === 0 ? '' : `; queued again: ${requeued.join(', ')}`)}` }
}

export const execute: RequestExecutor = (context, request, payload) => holdFor(context, request, payload, CARD_HELD)

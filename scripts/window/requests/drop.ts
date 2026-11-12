import type { RequestExecutor } from './context.js'
import { INTAKE_COMMAND } from '../../core/owner-commands.js'
import { appendEvent, CARD_DROPPED, cardBodyText, cardIdOf, DROPPED_CARD } from './reach.js'
import { ENDED_CARDS, text } from './request.js'

export const execute: RequestExecutor = (context, request, payload) => {
  const cardId = cardIdOf(payload.card)
  const reason = text(payload.reason)
  if (cardId === null || reason === null)
    return { done: false, why: 'drop needs a card and the reason it is dropped' }
  const card = context.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(cardId) as { state: string | null } | undefined
  if (card === undefined)
    return { done: false, why: `the bus holds no card #${cardId}` }
  if (ENDED_CARDS.has(card.state))
    return { done: false, why: `card #${cardId} is ${card.state}; there is nothing to drop` }
  if (cardBodyText(context.db, cardId) !== null)
    return { done: false, why: `card #${cardId} has an admitted body; it drops with ${INTAKE_COMMAND} --move '#${cardId}' --to ${DROPPED_CARD}` }
  appendEvent(context.db, { ts: context.now(), type: CARD_DROPPED, actor: context.actorOf(request), cardId, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:request-${request}`, payload: { request, reason }, legacy: false })
  return { done: true, why: `${CARD_DROPPED} #${cardId}: ${reason}` }
}

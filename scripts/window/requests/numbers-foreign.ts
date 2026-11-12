import type { RequestExecutor } from './context.js'
import { appendEvent, NUMBERS_FOREIGN } from './reach.js'
import { foreignIdsOf } from './request.js'

export const execute: RequestExecutor = (context, request, payload) => {
  const ids = foreignIdsOf(payload.ids)
  if (ids === null)
    return { done: false, why: 'numbers.foreign needs --ids, a list of positive card numbers' }
  appendEvent(context.db, { ts: context.now(), type: NUMBERS_FOREIGN, actor: context.actorOf(request), cardId: null, pr: null, head: null, dedupeKey: `${NUMBERS_FOREIGN}:request-${request}`, payload: { request, ids }, legacy: false })
  return { done: true, why: `${NUMBERS_FOREIGN} ${ids.map(id => `#${id}`).join(', ')}: the next card number no longer follows them` }
}

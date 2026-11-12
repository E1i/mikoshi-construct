import type { RequestExecutor } from './context.js'
import type { CloseRequest } from './reach.js'
import type { Executed, RequestPayload } from './request.js'
import { cardIdOf, prOf } from './reach.js'
import { text } from './request.js'

export function prCardAndReason(request: number, payload: RequestPayload): Omit<CloseRequest, 'by'> | Executed {
  const [pr, cardId, reason] = [prOf(payload.pr), cardIdOf(payload.card), text(payload.reason)]
  if (pr === null || cardId === null || reason === null)
    return { done: false, why: `${String(payload.kind)} needs a pr, a card and a reason` }
  return { attempt: `request-${request}`, pr, cardId, reason }
}

export const execute: RequestExecutor = (context, request, payload) => {
  const asked = prCardAndReason(request, payload)
  if ('done' in asked)
    return asked
  const closed = context.tools.closePr({ ...asked, by: 'window' })
  return { done: closed.kind === 'closed', why: closed.detail }
}

import type { RequestExecutor } from './context.js'
import { recordMove } from '../../core/order/turn.js'
import { prOf, QUEUE_ACTOR } from './reach.js'

export const ORDER_MOVE_USAGE = 'order.move needs --pr <N> and, to move it ahead of another member, --before <N>; with no --before the PR goes to the tail of its group\'s order'

export const execute: RequestExecutor = (context, request, payload) => {
  const pr = prOf(payload.pr)
  const before = payload.before === undefined ? null : prOf(payload.before)
  if (pr === null || (payload.before !== undefined && before === null) || before === pr)
    return { done: false, why: ORDER_MOVE_USAGE }
  const written = recordMove(context.db, context.now(), QUEUE_ACTOR, request, pr, before)
  return { done: true, why: `PR #${pr} moved ${before === null ? 'to the tail of its group\'s order' : `before PR #${before}`}${written ? '' : '; this request had already moved it'}` }
}

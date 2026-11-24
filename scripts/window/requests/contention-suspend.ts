import type { RequestExecutor } from './context.js'
import { BUS_CONTRACT } from '../../core/bus-adapter.js'
import { recordSuspension } from '../../core/order/turn.js'
import { prOf, QUEUE_ACTOR } from './reach.js'
import { foreignIdsOf, text } from './request.js'

export const CONTENTION_SUSPEND_USAGE = 'contention.suspend needs --ids <A>,<B>, the two pull requests whose contention is suspended, and may name --area <id> to suspend only that area; with no --area every contention area between the two is suspended'

export const execute: RequestExecutor = (context, request, payload) => {
  const ids = foreignIdsOf(payload.ids)
  const area = payload.area === undefined ? null : text(payload.area)
  if (ids === null || ids.length !== 2 || ids[0] === ids[1] || ids.some(id => prOf(id) === null) || (payload.area !== undefined && area === null))
    return { done: false, why: CONTENTION_SUSPEND_USAGE }
  const [first, second] = ids as [number, number]
  const written = recordSuspension(BUS_CONTRACT, context.db, context.now(), QUEUE_ACTOR, request, [first, second], area)
  const scope = area === null ? 'every contention area' : `the contention area ${area}`
  return { done: true, why: `${scope} between PR #${Math.min(first, second)} and PR #${Math.max(first, second)} is suspended: the order groups them by their own paths${written ? '' : '; this request had already suspended it'}` }
}

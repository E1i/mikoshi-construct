import type { RequestExecutor } from './context.js'
import { cardIdOf } from './reach.js'
import { messageOf, text } from './request.js'

export const execute: RequestExecutor = (context, _request, payload) => {
  const cardId = cardIdOf(payload.card)
  if (cardId === null)
    return { done: false, why: 'tree.cut names no card' }
  const body = context.db.prepare('SELECT card_line, branch FROM card_bodies WHERE card_id = ?').get(cardId) as { card_line: string | null, branch: string | null } | undefined
  const cardLine = text(body?.card_line)
  const branch = text(body?.branch)
  if (cardLine === null || branch === null)
    return { done: false, why: `card #${cardId} has no admitted card line and branch in card_bodies` }
  const tree = context.tools.treeOf(cardId)
  try {
    context.tools.cutTree(branch, cardLine)
  }
  catch (error) {
    return { done: false, why: `task:start ${branch} for card #${cardId} failed: ${messageOf(error)}` }
  }
  return context.tools.exists(tree) ? { done: true, why: `cut ${tree} on ${branch}` } : { done: false, why: `task:start ${branch} for card #${cardId} left no tree at ${tree}` }
}

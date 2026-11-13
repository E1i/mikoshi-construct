import type { RequestContext, RequestExecutor } from './context.js'
import type { OwnerMoveRequest } from './reach.js'
import type { Executed, RequestPayload } from './request.js'
import { appendEvent, cardIdOf, COMMAND_EXECUTED, consumeOwnerWord, OWNER, ownerMoveCommand, ownerMoveOf, ownerMoveUnsaid } from './reach.js'
import { text, unreleasedWord } from './request.js'

export interface OwnerMoveAsked {
  context: RequestContext
  request: number
  payload: RequestPayload
  cardId: number
  ts: string
}

export function ownerMoveExecutor(kind: OwnerMoveRequest, moved: (asked: OwnerMoveAsked) => Executed): RequestExecutor {
  return (context, request, payload) => {
    const [move, cardId, taskKey] = [ownerMoveOf(kind), cardIdOf(payload.card), text(payload.task_key)]
    const target = move === 'requeue' ? taskKey : cardId
    if (target === null)
      return { done: false, why: `${kind} names no ${move === 'requeue' ? 'task' : 'card'}` }
    const command = ownerMoveCommand(move, target)
    const word = consumeOwnerWord(context.ownerChannel, command, context.clock())
    if (word === null)
      return { done: false, why: ownerMoveUnsaid(command) }
    const ts = context.now()
    const outcome = moved({ context, request, payload, cardId: cardId!, ts })
    if (!outcome.done)
      return { done: false, why: `${outcome.why}; owner word ${word.file} ${word.release() ? 'left unused' : unreleasedWord(word.file)}` }
    appendEvent(context.db, { ts, type: COMMAND_EXECUTED, actor: OWNER, cardId, pr: null, head: null, dedupeKey: `${COMMAND_EXECUTED}:${kind}:request-${request}`, payload: { command, event_id: request, ok: true, text: outcome.why, ...(taskKey === null ? {} : { task_key: taskKey }) }, legacy: false })
    return { done: true, why: `${outcome.why}; owner word ${word.file} used` }
  }
}

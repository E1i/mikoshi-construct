import type { RequestExecutor } from './context.js'
import { appendEvent, FACTORY_MODE, FACTORY_MODES, isFactoryMode, QUEUE_ACTOR } from './reach.js'

export const execute: RequestExecutor = (context, request, payload) => {
  const mode = payload.mode
  if (!isFactoryMode(mode))
    return { done: false, why: `mode names ${JSON.stringify(mode ?? null)}, not one of ${FACTORY_MODES.join(', ')}` }
  appendEvent(context.db, { ts: context.now(), type: FACTORY_MODE, actor: QUEUE_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${FACTORY_MODE}:request-${request}`, payload: { mode, request }, legacy: false })
  return { done: true, why: `the factory mode is ${mode}` }
}

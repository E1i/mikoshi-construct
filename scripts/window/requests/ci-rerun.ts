import type { RequestExecutor } from './context.js'
import { prOf } from './reach.js'
import { noTool } from './request.js'

export const execute: RequestExecutor = (context, request, payload) => {
  const pr = prOf(payload.pr)
  if (pr === null)
    return { done: false, why: `${String(payload.kind)} names no pr` }
  return context.tools.rerunCi?.(`request-${request}`, pr) ?? noTool(`answer ${String(payload.kind)}`)
}

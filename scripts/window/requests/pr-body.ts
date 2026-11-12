import type { RequestExecutor } from './context.js'
import { prOf } from './reach.js'
import { noTool, text } from './request.js'

export const execute: RequestExecutor = (context, request, payload) => {
  const [pr, file] = [prOf(payload.pr), text(payload.file)]
  if (pr === null)
    return { done: false, why: `${String(payload.kind)} names no pr` }
  if (file !== null)
    return context.tools.appendBodyFile?.(`request-${request}`, pr, file) ?? noTool(`answer ${String(payload.kind)}`)
  const row = context.observed(pr)
  if (row?.state !== 'open')
    return { done: false, why: `PR #${pr} is not open` }
  if (row.card_id === null)
    return { done: false, why: `PR #${pr} names no card, so no report holds its count line` }
  return context.tools.appendCountLine?.(pr, row.card_id) ?? noTool('change a pull request body')
}

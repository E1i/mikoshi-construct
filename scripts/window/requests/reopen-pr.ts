import type { RequestExecutor } from './context.js'
import { prCardAndReason } from './close-pr.js'
import { noTool } from './request.js'

export const execute: RequestExecutor = (context, request, payload) => {
  const asked = prCardAndReason(request, payload)
  if ('done' in asked)
    return asked
  return context.tools.reopenPr?.(asked) ?? noTool('reopen a pull request')
}

import type { RequestExecutor } from './context.js'
import { holdFor } from './hold.js'
import { CARD_RELEASED } from './reach.js'

export const execute: RequestExecutor = (context, request, payload) => holdFor(context, request, payload, CARD_RELEASED)

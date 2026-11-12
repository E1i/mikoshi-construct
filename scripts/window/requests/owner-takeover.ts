import { ownerMoveExecutor } from './owner-move.js'
import { takeover } from './takeover.js'

export const execute = ownerMoveExecutor('owner.takeover', ({ context, request, payload }) => takeover(context, request, payload, true))

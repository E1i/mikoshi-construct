import { ownerMoveExecutor } from './owner-move.js'
import { requeue } from './requeue.js'

export const execute = ownerMoveExecutor('owner.requeue', ({ context, request, payload }) => requeue(context, request, payload, true))

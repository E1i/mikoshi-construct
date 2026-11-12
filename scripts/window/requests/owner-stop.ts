import { ownerMoveExecutor } from './owner-move.js'

export const execute = ownerMoveExecutor('owner.stop', ({ context, cardId }) => {
  const session = context.openSessionOf(cardId)
  return session === null ? { done: false, why: `card #${cardId} has no live session to stop: the bus holds no session of it that started and has not ended` } : { done: true, why: `the launch node stops the session of card #${cardId} started at event ${session} on its next pass` }
})

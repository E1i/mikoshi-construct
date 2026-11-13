import type { RequestContext, RequestExecutor } from './context.js'
import type { Executed } from './request.js'
import { OWNER_SAY_COMMAND } from '../../core/owner-commands.js'
import { activeDecisionsShard, ANSWER_SOURCE, appendEvent, closeOwnerWait, consumeOwnerWordClosing, deciderUnderAShard, decisionOnAWait, inTransaction, OPEN_OWNER_STOP_OF_CARD, OPEN_WAIT, OWNER_DECIDES, OWNER_SOURCE, OWNER_WAITS, OWNER_WORD_NOT_FOUND, ownerWordAwaited, QUEUE_ACTOR, SHARD_DECIDED, stopKindOf } from './reach.js'
import { flagsOf, messageOf, OWNER_ANSWER_USAGE, OWNER_WORD_NEEDED, text, unreleasedWord } from './request.js'

interface WaitToClose {
  state: string
  card_id: number | null
  need: string
}

const WAITS_A_DECISION_ANSWERS: ReadonlySet<string> = new Set(['decision', 'command'])

function boundToTheCard(context: RequestContext, id: string, cardId: number, answer: string): string {
  const words = decisionOnAWait(id, answer)
  if (context.sameWordsBoundTo(words, [cardId]) !== null)
    return `a decision with these words is bound to card #${cardId} already`
  const written = context.writtenDecision([...flagsOf('--card', `#${cardId}`), ...context.settledFlags(), `${OWNER_SOURCE} ${words}`])
  return written.code === 0 ? `bound to card #${cardId} as a decision: ${written.lines.join('; ')}` : `the decision binding it to card #${cardId} is not written: ${written.lines.join('; ')}`
}

function refusalToClose(context: RequestContext, request: number, id: string, answer: string): string | null {
  try {
    return inTransaction(context.db, () => closeOwnerWait(context.db, context.now(), QUEUE_ACTOR, id, answer, request)) ? null : `${id} is closed already`
  }
  catch (error) {
    return `owner.wait.close failed: ${messageOf(error)}`
  }
}

function closeWaitOnOwnerWord(context: RequestContext, request: number, id: string, wait: WaitToClose, stop: number | null): Executed {
  if (wait.state !== OPEN_WAIT)
    return { done: false, why: `${id} is closed already` }
  const word = consumeOwnerWordClosing(context.ownerChannel, id, context.clock())
  if (word === null)
    return { done: false, why: `${OWNER_WORD_NOT_FOUND}: ${ownerWordAwaited(id)}` }
  const answer = word.words
  const refusal = refusalToClose(context, request, id, answer)
  if (refusal !== null)
    return { done: false, why: `${refusal}; owner word ${word.file} ${word.release() ? 'left unused' : unreleasedWord(word.file)}` }
  const stillOpen = context.db.prepare(OPEN_OWNER_STOP_OF_CARD).get(wait.card_id) as { id: number } | undefined
  const closed = stop === null || stillOpen?.id === stop ? `closed ${id} on the owner's word ${word.file}: ${answer}` : `closed ${id} and lifted the card #${wait.card_id} stop ${stop} on the owner's word ${word.file}: ${answer}`
  return { done: true, why: wait.card_id !== null && WAITS_A_DECISION_ANSWERS.has(wait.need) ? `${closed}; ${boundToTheCard(context, id, wait.card_id, answer)}` : closed }
}

export const execute: RequestExecutor = (context, request, payload) => {
  const { db } = context
  const id = text(payload.id)
  const answer = text(payload.answer)
  const from = text(payload.from)
  if (id === null || (answer === null && from === null))
    return { done: false, why: 'owner.wait.close needs an id Q<N> and an answer, or --from the owner channel' }
  if (from !== null && from !== ANSWER_SOURCE)
    return { done: false, why: `owner.wait.close --from ${from} is not ${ANSWER_SOURCE}; only the owner's word that ${OWNER_SAY_COMMAND} put into the owner channel closes a wait as the owner's answer` }
  const wait = db.prepare(`SELECT state, card_id, need FROM ${OWNER_WAITS} WHERE id = ?`).get(id) as WaitToClose | undefined
  if (wait === undefined)
    return { done: false, why: `${id} is not an owner wait the bus has reduced` }
  const stop = wait.card_id === null ? undefined : db.prepare(OPEN_OWNER_STOP_OF_CARD).get(wait.card_id) as { id: number, payload: string } | undefined
  if (from !== null || answer === null)
    return closeWaitOnOwnerWord(context, request, id, wait, stop?.id ?? null)
  const shard = stop === undefined ? null : activeDecisionsShard(db, context.clock())
  const question = stop === undefined ? '' : String((JSON.parse(stop.payload) as Record<string, unknown>).detail ?? '')
  const reserved = shard !== null && deciderUnderAShard(question) === OWNER_DECIDES ? stopKindOf(question) : null
  if (reserved !== null)
    return { done: false, why: `${id} answers the card #${wait.card_id} stop ${stop!.id} on ${reserved}, which stays the owner's under any shard` }
  const ts = context.now()
  const closed = shard !== null && wait.state === OPEN_WAIT && inTransaction(db, () => {
    if (!closeOwnerWait(db, ts, QUEUE_ACTOR, id, answer, request))
      return false
    appendEvent(db, { ts, type: SHARD_DECIDED, actor: QUEUE_ACTOR, cardId: wait.card_id, pr: null, head: null, dedupeKey: `${SHARD_DECIDED}:${stop!.id}:${request}`, payload: { shard: shard.id, stop: stop!.id, wait: id, question, answer, ground: `the window's answer to ${id} under shard ${shard.id} (${shard.scope}, by ${shard.by}, until ${shard.until})` }, legacy: false })
    return true
  })
  if (!closed)
    return { done: false, why: shard === null && wait.state === OPEN_WAIT ? `${id} stays open: ${OWNER_WORD_NEEDED}; ${OWNER_ANSWER_USAGE}` : `${id} is closed already` }
  return { done: true, why: `closed ${id} and lifted the card #${wait.card_id} stop ${stop!.id} as a decision under shard ${shard.id}: ${answer}` }
}

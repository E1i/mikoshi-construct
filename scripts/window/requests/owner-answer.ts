import type { RequestContext, RequestExecutor } from './context.js'
import type { Executed } from './request.js'
import { ANSWER_SOURCE, CARD_STOPPED, cardIdOf, changesRoundsOf, closeOwnerWait, consumeOwnerWordClosing, decisionOnAWait, inTransaction, OPEN_WAIT, openPrOfCard, OWNER_SOURCE, OWNER_WAITS, OWNER_WORD_NOT_FOUND, ownerMoveCommand, QUEUE_ACTOR, REVIEW_ROUNDS } from './reach.js'
import { flagsOf, text, unreleasedWord } from './request.js'

interface Wait {
  id: string
  need: string
  card_id: number | null
  pr: number | null
}

const CONTINUE_FIXES = 'continue-fixes'
const ANSWER_WORD = 'answer'
const NEEDS_A_DECISION_ANSWERS: ReadonlySet<string> = new Set(['decision', 'command'])
const OPEN_WAIT_BY_ID = `SELECT id, need, card_id, pr FROM ${OWNER_WAITS} WHERE id = ? AND state = '${OPEN_WAIT}'`
const OPEN_WAITS_OF_CARD = `SELECT id, need, card_id, pr FROM ${OWNER_WAITS} WHERE card_id = ? AND state = '${OPEN_WAIT}' ORDER BY event_id`

function openWaits(context: RequestContext, id: string | null, card: number | null): Wait[] {
  return (id !== null ? context.db.prepare(OPEN_WAIT_BY_ID).all(id) : context.db.prepare(OPEN_WAITS_OF_CARD).all(card)) as unknown as Wait[]
}

function roundLimitedPr(context: RequestContext, wait: Wait | null, card: number | null): number | null {
  if (wait !== null && !NEEDS_A_DECISION_ANSWERS.has(wait.need))
    return null
  const pr = wait?.pr ?? (card === null ? null : openPrOfCard(context.db, card))
  return pr !== null && changesRoundsOf(context.db, pr) >= REVIEW_ROUNDS ? pr : null
}

function nothingToMove(context: RequestContext, card: number): string {
  const ended = context.routeOf(card, true)
  if (ended !== null)
    return `${ended}; no open wait, nothing moves`
  const route = context.routeOf(card)
  if (route !== null)
    return `card #${card} has no open wait and is within its round limit: ${route}, so the bus moves it already; nothing moves on this answer, and a decision bound with --card #${card} reaches its next session`
  const stopped = context.latestTurn(card, true)?.type === CARD_STOPPED
  return `card #${card} has no open wait and is within its round limit, and ${stopped ? 'it stands stopped' : 'no task or session of it runs'}; nothing moves on this answer. The move that would act on it: ${ownerMoveCommand('launch', card)}`
}

function bound(context: RequestContext, words: string, card: number | null): { done: boolean, why: string } {
  if (card === null)
    return { done: true, why: 'bound to no card' }
  if (context.sameWordsBoundTo(words, [card]) !== null)
    return { done: true, why: `a decision with these words is bound to card #${card} already` }
  const written = context.writtenDecision([...flagsOf('--card', `#${card}`), ...context.settledFlags(), `${OWNER_SOURCE} ${words}`])
  return { done: written.code === 0, why: written.lines.join('; ') }
}

function closed(context: RequestContext, request: number, wait: Wait, answer: string, bind: boolean): Executed {
  const shut = inTransaction(context.db, () => closeOwnerWait(context.db, context.now(), QUEUE_ACTOR, wait.id, answer, request))
  if (!shut)
    return { done: false, why: `${wait.id} is closed already` }
  if (!bind || !NEEDS_A_DECISION_ANSWERS.has(wait.need))
    return { done: true, why: `closed ${wait.id}: ${answer}` }
  const decision = bound(context, decisionOnAWait(wait.id, answer), wait.card_id)
  return { done: true, why: `closed ${wait.id}: ${answer}; ${decision.done ? `bound to card #${wait.card_id} as a decision: ${decision.why}` : `the decision binding it to card #${wait.card_id} is not written: ${decision.why}`}` }
}

export const execute: RequestExecutor = (context, request, payload) => {
  const words = text(payload.text)
  const id = text(payload.id)
  const card = cardIdOf(payload.card)
  if (words === null || text(payload.from) !== ANSWER_SOURCE || (id === null && card === null))
    return { done: false, why: `owner.answer needs a wait id Q<N> or a card, the owner's words and --from ${ANSWER_SOURCE}` }
  const target = id ?? `#${card}`
  const waits = openWaits(context, id, card)
  if (id !== null && waits.length === 0)
    return { done: false, why: `${id} is no open owner wait; nothing moves` }
  if (waits.length > 1)
    return { done: false, why: `card #${card} has ${waits.length} open waits (${waits.map(wait => wait.id).join(', ')}); answer one by its id; nothing moves` }
  const word = consumeOwnerWordClosing(context.ownerChannel, `${ANSWER_WORD} ${target}`, context.clock())
  if (word === null || word.words !== words) {
    const released = word === null || word.release() ? '' : `; ${unreleasedWord(word.file)}`
    return { done: false, why: `${OWNER_WORD_NOT_FOUND}: the owner's answer to ${target} is the line "${ANSWER_WORD} ${target}: ${words}" in the owner channel${released}` }
  }
  const wait = waits[0] ?? null
  const cardId = wait?.card_id ?? card
  const keepWord = (why: string): Executed => ({ done: false, why: `${why}; owner word ${word.file} ${word.release() ? 'left unused' : unreleasedWord(word.file)}` })
  const pr = roundLimitedPr(context, wait, cardId)
  if (pr !== null) {
    const head = context.observed(pr)?.head ?? null
    if (head === null)
      return keepWord(`PR #${pr} is past its review round limit and the bus has observed no head of it to name in continue-fixes`)
    const decided = `${CONTINUE_FIXES} PR #${pr} at ${head}: ${words}`
    const written = bound(context, decided, cardId)
    if (!written.done)
      return keepWord(`PR #${pr} is past its review round limit and continue-fixes is not written: ${written.why}`)
    const fixes = `continue-fixes for PR #${pr} at ${head}: ${written.why}`
    if (wait === null)
      return { done: true, why: fixes }
    const shut = closed(context, request, wait, decided, false)
    return { done: shut.done, why: `${fixes}; ${shut.why}` }
  }
  if (wait === null)
    return keepWord(nothingToMove(context, cardId!))
  return closed(context, request, wait, words, true)
}
